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

/**
 * Trần thời gian giữ một câu trong hàng đợi khi provider quá tải (503).
 *
 * ⚠️ Vì sao 503 không dùng chung `MAX_TRANSLATE_ATTEMPTS`: 503 là lỗi tạm thời
 * của provider và **không tiêu quota**, nên giữ câu chờ là an toàn — trần quota
 * 15 req/phút do bộ đếm cửa sổ giữ, không phải do việc bỏ sau N lần. Trước đây
 * 503 đi chung nhánh "tính công rồi bỏ", nên một đợt Gemini quá tải vài phút
 * **xoá vĩnh viễn bản dịch VI của cả đoạn** chứ không chỉ chậm hơn — đúng cái
 * "xoá sổ bản dịch cả video" đã xảy ra ở Issue 5.12. Vẫn cần trần để một lỗi
 * 503 kéo dài (model bị thu hồi, key hết hạn mà lỗi trả về 503) không giữ câu
 * vô hạn.
 */
const TRANSIENT_HOLD_MAX_MS = 5 * 60_000;

@WebSocketGateway()
export class AudioGateway implements OnGatewayConnection, OnGatewayDisconnect {
  // Biến lưu trữ tham chiếu WebSocket client của Extension Chrome đang kết nối
  private extensionClient?: WebSocket;

  private readonly pending = new Map<number, string>();

  private drainTimer: ReturnType<typeof setTimeout> | undefined;

  private draining = false;

  /** Số lần đã thử của mỗi nhóm, để thôi thử lại sau MAX_TRANSLATE_ATTEMPTS. */
  private readonly attempts = new Map<number, number>();

  /**
   * Mốc lúc một nhóm bắt đầu bị GIỮ vì 503 — khác `attempts` ở chỗ nó đo
   * THỜI GIAN chờ, không đếm lần. Xem `TRANSIENT_HOLD_MAX_MS`.
   */
  private readonly heldSince = new Map<number, number>();

  /**
   * Không được thử lại trước mốc này sau một đợt 503.
   *
   * ⚠️ Cần riêng vì `msUntilRoom()` chỉ biết QUOTA, không biết provider đang
   * quá tải: sau 503 thì cửa sổ vẫn còn chỗ ⇒ timer nổ ngay lập tức ⇒ 503 lặp
   * liên tục, đốt hết lượt của các câu mới trong lúc model đang chết.
   *
   * Giữ ở gateway chứ không `pauseUntil` trên limiter dùng chung: 503 là lỗi
   * của CHÍNH request (gotcha #26), không phải trạng thái của cả project — đường
   * HTTP không có lý do bị chặn theo.
   */
  private drainNotBefore = 0;

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
    // `msUntilRoom()` đã bao gồm cả cooldown toàn cục — xem
    // TranslationRateLimiter.pauseUntil. Lấy max với `drainNotBefore` để
    // không thử lại trong lúc provider còn đang quá tải.
    const wait = Math.max(
      this.rateLimiter.msUntilRoom(),
      this.drainNotBefore - Date.now(),
      0,
    );

    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      void this.drain();
    }, wait);
  }


  /** Nhóm này đã bị giữ chờ 503 quá lâu chưa? Xem `TRANSIENT_HOLD_MAX_MS`. */
  private hasHeldTooLong(captionStart: number, now: number): boolean {
    const since = this.heldSince.get(captionStart);
    return since !== undefined && now - since >= TRANSIENT_HOLD_MAX_MS;
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
    try {
      const results = await this.translateService.translateBatch(
        batch.map((g) => g.text),
        'vi',
        'en',
      );

      batch.forEach((group, index) => {
        // Xoá mốc giữ NGAY khi thành công: để sót lại thì lần 503 sau nhóm này
        // bị coi là "đã giữ quá lâu" và bị bỏ oan.
        this.heldSince.delete(group.captionStart);
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
      // ⚠️ Ba nhánh, KHÁC NHAU về hậu quả — xem `ProviderUnavailableError`.
      const now = Date.now();
      const quotaError =
        error instanceof ProviderUnavailableError && !error.retryable;
      const overloaded = error instanceof ProviderUnavailableError && error.retryable;
      // 503 đã giữ quá trần ⇒ bỏ (còn câu mới trong hàng đợi vẫn được thử).
      const heldTooLong = batch.some((g) => this.hasHeldTooLong(g.captionStart, now));

      if (quotaError) {
        // Lỗi quota: KHÔNG thuộc về câu nào cả, cả project đang cạn quota.
        // Trả các nhóm về hàng đợi và KHÔNG tăng `attempts` — đếm nó là công
        // của câu thì một đợt cạn quota kéo dài sẽ xoá sổ bản dịch của cả
        // video.
        // Cooldown nằm ở limiter dùng chung, nên đường HTTP cũng dừng theo.
        this.rateLimiter.pauseUntil(now + error.retryAfterMs);
        for (const group of batch) {
          this.pending.set(group.captionStart, group.text);
        }
        console.warn(
          `Translation paused ${Math.round(error.retryAfterMs / 1000)}s (quota), ` +
            `re-queued ${batch.length} sentences`,
        );
      } else if (overloaded && !heldTooLong) {
        // 503 = model quá tải: TẠM THỜI và không tiêu quota ⇒ giữ câu trong
        // hàng đợi, KHÔNG tính công, chờ provider hồi.
        //
        // ⚠️ Phải khai báo lịch nghỉ cho chính drain này (`drainNotBefore`),
        // không chỉ re-queue: cửa sổ quota vẫn còn chỗ sau 503 nên nếu không,
        // `scheduleDrain` hẹn 0ms và 503 lặp lại liên tục.
        this.drainNotBefore = Math.max(
          this.drainNotBefore,
          now + error.retryAfterMs,
        );
        for (const group of batch) {
          if (!this.heldSince.has(group.captionStart)) {
            this.heldSince.set(group.captionStart, now);
          }
          this.pending.set(group.captionStart, group.text);
        }
        console.warn(
          `Translation held (provider overloaded), re-queued ${batch.length} sentences`,
        );
      } else {
        // Còn lại: lỗi của CHÍNH batch (400/401/500) — tính công rồi bỏ sau MAX
        // lần; hoặc 503 đã giữ quá `TRANSIENT_HOLD_MAX_MS`.
        for (const group of batch) {
          this.attempts.set(
            group.captionStart,
            (this.attempts.get(group.captionStart) ?? 0) + 1,
          );
          this.heldSince.delete(group.captionStart);
        }
        console.warn(
          `Translation batch skipped (${batch.length} sentences):`,
          error instanceof Error ? error.message : error,
        );
      }
    } finally {
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

            // ⚠️ Phải báo XUỐNG sidecar nữa, không chỉ reset clock ở đây.
            // Sidecar đang giữ tới 6s tiếng của đoạn TRƯỚC khi tua; để nguyên
            // thì window kế tiếp trộn tiếng cũ với tiếng mới nhưng dán mốc mới
            // ⇒ phụ đề đúng ngay lúc tua rồi lệch ở đoạn ngay sau (Issue 5.21).
            this.sidecarService.sendReset();

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
