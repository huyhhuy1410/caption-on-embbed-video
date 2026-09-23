import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import { RawData, WebSocket } from 'ws';
import { SidecarService } from './sidecar/sidecar.service';
import { TranscriptService } from './transcript/transcript.service';
import { VideoClockService } from './clock/video-clock.service';
import { TranslateService } from '../ai/translate.service';

/** Một caption group: các từ dùng chung một `captionStart`. */
type CaptionGroup = { captionStart: number; text: string };

/** Số lần thử tối đa cho một câu trước khi tạm bỏ nó. */
const MAX_TRANSLATE_ATTEMPTS = 3;

/**
 * Khoang cach toi thieu giua hai request dich.
 *
 * Gemini free tier cho ~15 request/phut => 60/15 = 4000ms. Giu dung 4000ms thi
 * khong bao gio vuot tran, ke ca khi caption ve don dap.
 */
const TRANSLATE_MIN_INTERVAL_MS = 4_000;

@WebSocketGateway()
export class AudioGateway implements OnGatewayConnection, OnGatewayDisconnect {
  // Biến lưu trữ tham chiếu WebSocket client của Extension Chrome đang kết nối
  private extensionClient?: WebSocket;

  /** Nhóm đang dịch dở, khoá theo `captionStart`. */
  private readonly inFlight = new Set<number>();

  private readonly pending = new Map<number, string>();

  private drainTimer: ReturnType<typeof setTimeout> | undefined;

  private lastDrainAt = 0;

  /** Số lần đã thử của mỗi nhóm, để thôi thử lại sau MAX_TRANSLATE_ATTEMPTS. */
  private readonly attempts = new Map<number, number>();

  // === BƯỚC 1: Constructor - Thiết lập kết nối hai chiều với Sidecar Service ===
  constructor(
    private readonly sidecarService: SidecarService,
    private readonly transcriptService: TranscriptService,
    private readonly videoClockService: VideoClockService,
    private readonly translateService: TranslateService,
  ) {
    // 1.1. Đăng ký callback lắng nghe kết quả Subtitle trả về từ Python Sidecar
    this.sidecarService.setMessageHandler((data) => {
      console.info('Message from sidecar:', data);

      // 1.2. Nếu Extension đang mở kết nối, bắn thẳng kết quả JSON về cho Extension!

      const message = data.toString();
      try {
        const parsedMessage = JSON.parse(message);
        if (parsedMessage.type === 'words') {
          this.transcriptService.addWords(parsedMessage.words);
          // Dịch SAU khi đã forward/ghi cache — không chặn đường words.
          this.enqueueForTranslation(collectCaptionGroups(parsedMessage.words));
        }
      } catch (error) {
        console.warn('Failed to parse message', error);
      }
      if (
        this.extensionClient &&
        this.extensionClient.readyState === WebSocket.OPEN
      ) {
        this.extensionClient.send(message);
      }
    });
  }

  /**
   * Xếp các caption group chưa có bản dịch vào hàng đợi, rồi hẹn một lượt
   * drain.
   *
   * ⚠️ Vì sao xếp hàng thay vì gọi ngay: dịch từng câu riêng tốn 1 request/câu.
   * Nhịp sinh caption là ~15–25 nhóm/phút, mà Gemini free tier cho ~15
   * request/phút ⇒ vượt trần ngay trong điều kiện bình thường. Gộp nhiều câu
   * vào một request là cách duy nhất giảm số request mà không giảm số câu.
   *
   * `enqueue` là ĐỒNG BỘ, `drain` chạy ở macrotask sau ⇒ mọi nhóm trong cùng
   * một message `words` tự nhiên gộp thành một request, không cần chờ thêm.
   */
  private enqueueForTranslation(groups: CaptionGroup[]): void {
    for (const group of groups) {
      const cached = this.transcriptService.getTranslation(group.captionStart);
      // ⚠️ So cả TEXT, không chỉ khoá. Một nhóm caption có thể bị cắt ngang
      // ranh giới window 6s: lần đầu chỉ thấy nửa câu, lần sau mới đủ. Nếu chỉ
      // kiểm tra khoá thì bản dịch NỬA CÂU đã cache sẽ chặn luôn bản đầy đủ.
      if (cached && cached.text === group.text) continue;

      const tried = this.attempts.get(group.captionStart) ?? 0;
      if (tried >= MAX_TRANSLATE_ATTEMPTS) continue;

      // Ghi đè: nhóm có thể đã trong hàng đợi với text CŨ (ngắn hơn), giờ dài
      // ra. Bản mới nhất là bản đúng.
      this.pending.set(group.captionStart, group.text);
    }
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.pending.size === 0 || this.drainTimer !== undefined) return;

    // Chừa khoảng cách tối thiểu giữa hai request để không vượt trần RPM.
    const elapsed = Date.now() - this.lastDrainAt;
    const delay = Math.max(0, TRANSLATE_MIN_INTERVAL_MS - elapsed);
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      void this.drain();
    }, delay);
  }

  /**
   * Dịch mọi nhóm đang chờ trong MỘT request.
   *
   * Fire-and-forget: FR-5.2 cho phép VI đến muộn 1–3s, nên không được để HTTP
   * call chặn luồng `words`. Lỗi (hết quota, mạng, thiếu key) chỉ log — caption
   * EN phải chạy bất kể.
   */
  private async drain(): Promise<void> {
    const batch = Array.from(this.pending.entries()).map(
      ([captionStart, text]) => ({ captionStart, text }),
    );
    this.pending.clear();
    if (batch.length === 0) return;

    this.lastDrainAt = Date.now();
    for (const group of batch) {
      // `inFlight` chặn trùng trong lúc chờ: nguồn dữ liệu re-emit cùng nhóm
      // mỗi ~4.5s, và cache chỉ ghi khi THÀNH CÔNG nên thất bại không để lại
      // dấu vết nào.
      this.inFlight.add(group.captionStart);
      this.attempts.set(
        group.captionStart,
        (this.attempts.get(group.captionStart) ?? 0) + 1,
      );
    }

    try {
      const results = await this.translateService.translateBatch(
        batch.map((g) => g.text),
        'vi',
        'en',
      );

      batch.forEach((group, index) => {
        const vi = results[index]?.text.trim();
        if (!vi) return;

        this.transcriptService.setTranslation({
          captionStart: group.captionStart,
          text: group.text,
          vi,
        });
        this.sendToExtension({
          type: 'translation',
          captionStart: group.captionStart,
          text: group.text,
          vi,
        });
      });
    } catch (error: unknown) {
      console.warn(
        `Translation batch skipped (${batch.length} sentences):`,
        error instanceof Error ? error.message : error,
      );
    } finally {
      for (const group of batch) {
        this.inFlight.delete(group.captionStart);
      }
      // Nhóm mới có thể đã về trong lúc đang chờ request này.
      this.scheduleDrain();
    }
  }

  private sendToExtension(payload: object): void {
    if (
      this.extensionClient &&
      this.extensionClient.readyState === WebSocket.OPEN
    ) {
      this.extensionClient.send(JSON.stringify(payload));
    }
  }

  // === BƯỚC 2: Sự kiện khi Extension Chrome mở kết nối WebSocket (Cổng 8000) ===
  handleConnection(client: WebSocket) {
    console.info('Extension connected to audio WebSocket');
    this.extensionClient = client; // Lưu tham chiếu client vào cấp Class

    client.on('error', (err) => {
      console.error('Extension audio WebSocket error:', err);
    });

    // 2.1. Lắng nghe từng gói tin từ Extension gửi lên
    client.on('message', (data: RawData, isBinary: boolean) => {
      // Nhánh A: Nếu là dữ liệu Nhị phân (PCM Audio Bytes)
      if (isBinary) {
        console.info('Received PCM bytes:', rawDataLength(data));
        const buffer = toBuffer(data);
        this.sidecarService.sendAudio(buffer); // Forward mảng byte cho Sidecar Python
        return;
      }

      // Nhánh B: Nếu là dữ liệu Chữ (JSON Metadata)
      try {
        const parsed: unknown = JSON.parse(data.toString());
        console.info('Received message:', parsed);
        if (isRecord(parsed) && parsed.type === 'seek') {
          const seekTime = (parsed as { seekTimeAtCapture?: number })
            .seekTimeAtCapture;
          console.info('Backend: seek received', parsed);
          if (seekTime !== undefined) {
            this.videoClockService.reset();

            const from = seekTime;
            const to = seekTime + 3;
            const replayWords = this.transcriptService.getRange(from, to);
            // Kèm bản dịch đã cache để VI hiện ngay, không gọi AI lại (FR-7.5).
            const replayTranslations = this.transcriptService.getTranslations(
              from,
              to,
            );
            console.info('Seek received:', seekTime);
            console.info('Replay words:', replayWords.length);
            this.sendToExtension({
              type: 'replay',
              seekTime,
              words: replayWords,
              translations: replayTranslations,
            });
          }
        } else {
          // Gắn lại anchor: video time tại ĐẦU audio của chunk này, không phải
          // tại lúc gửi. Xem VideoClockService.
          const withAnchor =
            isRecord(parsed) && typeof parsed.videoTimeAtCapture === 'number'
              ? {
                  ...parsed,
                  videoTimeAtCapture: this.videoClockService.resolveAnchor(
                    parsed.videoTimeAtCapture,
                  ),
                }
              : parsed;
          this.sidecarService.sendMetadata(withAnchor);
        }
      } catch {
        console.warn('Received invalid JSON message');
      }
    });
  }

  // === BƯỚC 3: Sự kiện khi Extension ngắt kết nối ===
  handleDisconnect() {
    console.info('Extension disconnected from audio WebSocket');
    this.extensionClient = undefined; // Dọn dẹp biến tham chiếu
  }
}

// === BƯỚC 4: Helper gom từ thành caption group (theo `captionStart` của sidecar) ===
/**
 * Sidecar chốt nhóm caption bằng `captionStart` (gặp dấu kết câu hoặc đủ 8 từ).
 * Backend gom lại theo chính khoá đó — không cần sidecar phát thêm event
 * `sentence`, vì extension vốn đã tự gom nhóm để dựng dòng EN; nó chỉ thiếu
 * bản dịch.
 */
function collectCaptionGroups(words: unknown): CaptionGroup[] {
  if (!Array.isArray(words)) return [];

  const groups = new Map<number, string[]>();
  for (const raw of words) {
    if (!isRecord(raw)) continue;
    const text = typeof raw.w === 'string' ? raw.w : '';
    const captionStart = raw.captionStart;
    if (!text || typeof captionStart !== 'number') continue;

    const existing = groups.get(captionStart);
    if (existing) {
      existing.push(text);
    } else {
      groups.set(captionStart, [text]);
    }
  }

  const result: CaptionGroup[] = [];
  for (const [captionStart, parts] of groups) {
    result.push({ captionStart, text: parts.join(' ') });
  }
  return result.sort((a, b) => a.captionStart - b.captionStart);
}

// === BƯỚC 5: Helper chuyển đổi dữ liệu thô RawData thành Node.js Buffer ===
function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(data)); // Đọc ArrayBuffer bằng kính Uint8Array
  }

  return Buffer.from(data);
}

// === BƯỚC 5: Helper tính độ dài dung lượng (Byte length) của RawData ===
function rawDataLength(data: RawData): number {
  if (typeof data === 'string') return Buffer.byteLength(data);
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return data.byteLength;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
