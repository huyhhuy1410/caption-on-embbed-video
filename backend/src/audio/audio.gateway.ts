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
import { TranslationRateLimiter } from '../ai/translation-rate-limiter.service';
import { ProviderUnavailableError } from '../ai/errors';

/** Một caption group: các từ dùng chung một `captionStart`. */
type CaptionGroup = { captionStart: number; text: string };

/** Số lần thử tối đa cho một câu trước khi tạm bỏ nó. */
const MAX_TRANSLATE_ATTEMPTS = 3;

@WebSocketGateway()
export class AudioGateway implements OnGatewayConnection, OnGatewayDisconnect {
  // Biến lưu trữ tham chiếu WebSocket client của Extension Chrome đang kết nối
  private extensionClient?: WebSocket;

  /** Nhóm đang dịch dở, khoá theo `captionStart`. */
  private readonly inFlight = new Set<number>();

  private readonly pending = new Map<number, string>();

  private drainTimer: ReturnType<typeof setTimeout> | undefined;

  private draining = false;

  /**
   * Mốc thời gian được phép gọi lại sau khi provider báo hết quota.
   *
   * Chỉ dùng cho lỗi quota (`retryable = false`) — đó là trạng thái của CẢ
   * PROJECT, nên phải tạm dừng MỌI request chứ không riêng batch vừa hỏng.
   */
  private cooldownUntil = 0;

  /** Số lần đã thử của mỗi nhóm, để thôi thử lại sau MAX_TRANSLATE_ATTEMPTS. */
  private readonly attempts = new Map<number, number>();

  // === BƯỚC 1: Constructor - Thiết lập kết nối hai chiều với Sidecar Service ===
  constructor(
    private readonly sidecarService: SidecarService,
    private readonly transcriptService: TranscriptService,
    private readonly videoClockService: VideoClockService,
    private readonly translateService: TranslateService,
    private readonly rateLimiter: TranslationRateLimiter,
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

  /**
   * Hẹn lượt drain kế tiếp, chờ tới khi cửa sổ quota còn chỗ.
   *
   * ⚠️ Guard `draining` là bắt buộc, không phải cho đẹp: `drainTimer` được xoá
   * lúc timer NỔ, không phải lúc drain XONG. Một drain có retry sẽ await hàng
   * giây, suốt thời gian đó `drainTimer` là `undefined` ⇒ không còn gì chặn việc
   * hẹn drain mới ⇒ nhiều request chạy chồng, cùng key, cùng bucket quota.
   */
  private scheduleDrain(): void {
    if (this.pending.size === 0) return;
    if (this.drainTimer !== undefined || this.draining) return;

    // Còn chỗ trong cửa sổ thì bắn ngay. Đây là chủ ý: caption về theo từng đợt
    // ~4.5s, nên gộp được nhóm nào thì dòng VI hiện sớm được nhóm đó — chờ thêm
    // chỉ làm bản dịch đến muộn mà không giúp gì cho quota.
    const wait = Math.max(
      this.rateLimiter.msUntilRoom(),
      this.cooldownUntil - Date.now(),
    );

    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      void this.drain();
    }, wait);
  }


  /**
   * Dịch mọi nhóm đang chờ trong MỘT request.
   *
   * Fire-and-forget: FR-5.2 cho phép VI đến muộn 1–3s, nên không được để HTTP
   * call chặn luồng `words`. Lỗi (hết quota, mạng, thiếu key) chỉ log — caption
   * EN phải chạy bất kể.
   */
  private async drain(): Promise<void> {
    // ⚠️ Kiểm lại quota NGAY TRƯỚC khi tiêu, dù `scheduleDrain` đã tính rồi.
    // Đây là chốt chặn duy nhất nằm đúng chỗ request thật sự rời máy, nên bất
    // biến "≤15 request/60s" được giữ tại đây thay vì phụ thuộc vào việc timer
    // không bao giờ nổ sớm (đồng hồ hệ thống nhảy, timer bị dồn...). Trả batch về
    // hàng đợi rồi hẹn lại — không mất câu nào.
    if (this.rateLimiter.msUntilRoom() > 0) {
      this.scheduleDrain();
      return;
    }

    const batch = Array.from(this.pending.entries()).map(
      ([captionStart, text]) => ({ captionStart, text }),
    );
    this.pending.clear();
    if (batch.length === 0) return;

    this.draining = true;
    // Ghi mốc NGAY TRƯỚC khi bắn — đây là bộ đếm quota, phải khớp số request
    // thật đã rời máy, kể cả request rồi thất bại.
    this.rateLimiter.recordCall();
    for (const group of batch) {
      // Chặn nhóm đang bay khỏi bị enqueue lại lần nữa.
      this.inFlight.add(group.captionStart);
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
      // ⚠️ Cờ `retryable` quyết định nhánh nào — hai nhánh KHÁC NHAU về hậu quả.
      // Xem `ProviderUnavailableError` để biết vì sao không được gộp chúng.
      //
      // Lỗi quota (`retryable = false`): KHÔNG thuộc về câu nào cả, cả project
      // đang cạn quota. Trả các nhóm về hàng đợi và KHÔNG tăng `attempts` — đếm
      // nó là công của câu thì một đợt cạn quota kéo dài sẽ xoá sổ bản dịch của
      // cả video.
      if (error instanceof ProviderUnavailableError && !error.retryable) {
        this.cooldownUntil = Date.now() + error.retryAfterMs;
        for (const group of batch) {
          this.pending.set(group.captionStart, group.text);
        }
        console.warn(
          `Translation paused ${Math.round(error.retryAfterMs / 1000)}s (quota), ` +
            `re-queued ${batch.length} sentences`,
        );
      } else {
        // Còn lại — kể cả 503 model quá tải — là lỗi thuộc về CHÍNH batch này,
        // nên tính công rồi bỏ sau MAX lần; không thể giữ câu trong hàng đợi vô
        // hạn chỉ vì model đang quá tải.
        for (const group of batch) {
          this.attempts.set(
            group.captionStart,
            (this.attempts.get(group.captionStart) ?? 0) + 1,
          );
        }
        console.warn(
          `Translation batch skipped (${batch.length} sentences):`,
          error instanceof Error ? error.message : error,
        );
      }
    } finally {
      for (const group of batch) {
        this.inFlight.delete(group.captionStart);
      }
      this.draining = false;
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
