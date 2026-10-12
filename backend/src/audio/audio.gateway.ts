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
import {
  CaptureScope,
  isScope,
  sameScope,
  captionKey,
} from './streaming-transcript';

/** Windowed dùng mốc thời gian; streaming dùng identity ổn định. */
type CaptionGroup = { captionStart: number; text: string; captionId?: string; windowedGroupId?: string };

/**
 * Khoá hàng đợi dịch = (nguồn, captionStart).
 *
 * `captionStart` là mốc thời gian RIÊNG của từng video: video B bắt đầu
 * câu đầu tiên ở 0:00 cũng hệt video A. Khoá bằng `captionStart` đơn thuần thì
 * câu của video A bị xem như đã thử (nên bỏ, không dịch lại) hoặc nhận nhầm bản
 * dịch của video B (Issue 5.20).
 */
function queueKey(
  sourceId: string | null,
  captionStart: number,
  captionId?: string,
): string {
  return captionId
    ? captionKey(sourceId, captionId)
    : `${sourceId ?? ''}|${captionStart}`;
}

/** Nhóm đã gắn nguồn, dùng khi xếp hàng dịch. Xem `enqueueForTranslation`. */
type QueuedGroup = CaptionGroup & {
  sourceId: string | null;
  sessionId?: string;
  generation?: number;
  client?: WebSocket;
  enqueuedAt?: number;
};

/** Số lần thử tối đa cho một câu trước khi tạm bỏ nó. */
const MAX_TRANSLATE_ATTEMPTS = 3;

/**
 * Trần thời gian giữ một câu trong hàng đợi khi provider quá tải (503).
 *
 * Vì sao 503 không dùng chung `MAX_TRANSLATE_ATTEMPTS`: 503 là lỗi tạm thời
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
  private extensionClient?: WebSocket;

  /**
   * `sourceId` của video ĐANG CHẠY — khoá cache theo nguồn (Issue 5.20).
   *
   * Đây là biến SỐNG SUỐT phiên, không phải biến đi kèm message: backend
   * nhận audio của mọi video trong tab (tabCapture), nên nó phải nhớ nguồn hiện
   * tại để gán cho `getRange`/`getTranslations` khi seek. Đổi video mà không
   * cập nhật biến này thì replay trả lời của video trước.
   */
  private activeSourceId: string | null = null;
  private activeScope?: CaptureScope;
  private awaitingAudio = false;
  private readonly inFlight = new Set<string>();

  /** value là `QueuedGroup` — phải giữ `sourceId` để drain ghi cache đúng nguồn. */
  private readonly pending = new Map<string, QueuedGroup>();

  private drainTimer: ReturnType<typeof setTimeout> | undefined;

  private draining = false;
  private translationBatchSequence = 0;

  /** Số lần đã thử của mỗi nhóm, để thôi thử lại sau MAX_TRANSLATE_ATTEMPTS. */
  private readonly attempts = new Map<string, number>();

  /**
   * Mốc lúc một nhóm bắt đầu bị GIỮ vì 503 — khác `attempts` ở chỗ nó đo
   * THỜI GIAN chờ, không đếm lần. Xem `TRANSIENT_HOLD_MAX_MS`.
   */
  private readonly heldSince = new Map<string, number>();

  /**
   * Không được thử lại trước mốc này sau một đợt 503.
   *
   * Cần riêng vì `msUntilRoom()` chỉ biết QUOTA, không biết provider đang
   * quá tải: sau 503 thì cửa sổ vẫn còn chỗ ⇒ timer nổ ngay lập tức ⇒ 503 lặp
   * liên tục, đốt hết lượt của các câu mới trong lúc model đang chết.
   *
   * Giữ ở gateway chứ không `pauseUntil` trên limiter dùng chung: 503 là lỗi
   * của CHÍNH request (gotcha #26), không phải trạng thái của cả project — đường
   * HTTP không có lý do bị chặn theo.
   */
  private drainNotBefore = 0;

  constructor(
    private readonly sidecarService: SidecarService,
    private readonly transcriptService: TranscriptService,
    private readonly videoClockService: VideoClockService,
    private readonly translateService: TranslateService,
    private readonly rateLimiter: TranslationRateLimiter,
  ) {
    this.sidecarService.setOpenHandler(() => {
      // Sidecar giữ state theo từng WS connection; reconnect = buffer/source
      // sạch. Gửi lại nguồn HIỆN TẠI để window đầu sau reload vào đúng namespace.
      if (this.activeScope)
        this.sendToExtension({
          type: 'sidecar-reconnected',
          ...this.activeScope,
        });
      if (!this.activeScope && this.activeSourceId !== null) {
        this.sidecarService.sendSourceSwitch(this.activeSourceId);
      }
    });

    this.sidecarService.setMessageHandler((data) => {
      console.info('Message from sidecar:', data);

      const message = data.toString();
      try {
        const parsedMessage = JSON.parse(message);
        if (parsedMessage.type === 'words') {
          if (parsedMessage.mode === 'streaming') {
            if (
              !this.extensionClient ||
              !this.activeScope ||
              !isScope(parsedMessage) ||
              !sameScope(this.activeScope, parsedMessage)
            )
              return;
            const applied =
              this.transcriptService.applyStreamingUpdate(parsedMessage);
            if (!applied) return;
            this.sendToExtension(applied.update);
            for (const caption of applied.update.captions.filter(
              (c) => c.finalized,
            )) {
              const cached = this.transcriptService.getTranslation(
                this.activeSourceId,
                caption.captionId,
              );
              if (cached)
                this.sendToExtension({ type: 'translation', ...cached, ...this.activeScope });
            }
            this.enqueueForTranslation(
              applied.finalized.map((c) => ({
                captionId: c.state.captionId,
                captionStart: c.state.captionStart,
                text: c.words.map((w) => w.w).join(' '),
              })),
            );
            return;
          }
          if (
            this.activeScope &&
            (!isScope(parsedMessage) ||
              !sameScope(this.activeScope, parsedMessage))
          )
            return;
          if (
            parsedMessage.words?.some(
              (w: { sourceId?: string | null }) =>
                (w.sourceId ?? null) !== this.activeSourceId,
            )
          )
            return;
          if (!Array.isArray(parsedMessage.words)) return;
          const patch = this.transcriptService.addWords(parsedMessage.words);
          this.sendToExtension({ ...parsedMessage, ...patch });
          this.enqueueForTranslation(collectCaptionGroups(patch.words));
          return;
        }
      } catch (error) {
        console.warn('Failed to parse message', error);
        return;
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
   * Vì sao xếp hàng thay vì gọi ngay: dịch từng câu riêng tốn 1 request/câu.
   * Nhịp sinh caption là ~15–25 nhóm/phút, mà Gemini free tier cho ~15
   * request/phút ⇒ vượt trần ngay trong điều kiện bình thường. Gộp nhiều câu
   * vào một request là cách duy nhất giảm số request mà không giảm số câu.
   *
   * `enqueue` là ĐỒNG BỘ, `drain` chạy ở macrotask sau ⇒ mọi nhóm trong cùng
   * một message `words` tự nhiên gộp thành một request, không cần chờ thêm.
   */
  private enqueueForTranslation(groups: CaptionGroup[]): void {
    for (const group of groups) {
      const cached = this.transcriptService.getTranslation(
        this.activeSourceId,
        group.windowedGroupId ?? group.captionId ?? group.captionStart,
      );
      // So cả TEXT, không chỉ khoá. Một nhóm caption có thể bị cắt ngang
      // ranh giới window: lần đầu chỉ thấy nửa câu, lần sau mới đủ. Nếu chỉ
      // kiểm tra khoá thì bản dịch NỬA CÂU đã cache sẽ chặn luôn bản đầy đủ.
      if (cached && cached.text === group.text) {
        this.sendToExtension({ type: 'translation', ...cached, ...this.activeScope });
        continue;
      }

      // Ghi nguồn vào nhóm NGAY LÚC XẾP HÀNG, không đọc `activeSourceId` lúc
      // drain — drain có thể chạy vài giây sau, mà user đã kịp đổi video ⇒ bản
      // dịch của video cũ bị ghi vào namespace của video mới.
      const queued: QueuedGroup = {
        captionStart: group.captionStart,
        captionId: group.captionId,
        windowedGroupId: group.windowedGroupId,
        text: group.text,
        sourceId: this.activeSourceId,
        sessionId: this.activeScope?.sessionId,
        generation: this.activeScope?.generation,
        client: this.extensionClient,
      };
      const key = queueKey(
        queued.sourceId,
        queued.captionStart,
        queued.windowedGroupId ?? queued.captionId,
      );
      if ((queued.captionId || queued.windowedGroupId) && this.inFlight.has(key)) continue;
      const tried = this.attempts.get(key) ?? 0;
      if (tried >= MAX_TRANSLATE_ATTEMPTS) continue;

      // Ghi đè: nhóm có thể đã trong hàng đợi với text CŨ (ngắn hơn), giờ dài
      // ra. Bản mới nhất là bản đúng.
      queued.enqueuedAt = this.pending.get(key)?.enqueuedAt ?? Date.now();
      this.pending.set(key, queued);
      while (this.pending.size > 300)
        this.pending.delete(this.pending.keys().next().value!);
      while (this.attempts.size > 300)
        this.attempts.delete(this.attempts.keys().next().value!);
      while (this.heldSince.size > 300)
        this.heldSince.delete(this.heldSince.keys().next().value!);
    }
    this.scheduleDrain();
  }

  /**
   * Hẹn lượt drain kế tiếp, chờ tới khi cửa sổ quota còn chỗ.
   *
   * Guard `draining` là bắt buộc, không phải cho đẹp: `drainTimer` được xoá
   * lúc timer NỔ, không phải lúc drain XONG. Một drain có retry sẽ await hàng
   * giây, suốt thời gian đó `drainTimer` là `undefined` ⇒ không còn gì chặn việc
   * hẹn drain mới ⇒ nhiều request chạy chồng, cùng key, cùng bucket quota.
   */
  private scheduleDrain(): void {
    if (this.pending.size === 0) return;
    if (this.drainTimer !== undefined || this.draining) return;

    // Còn chỗ trong cửa sổ thì bắn ngay. Đây là chủ ý: caption về theo từng đợt
    // ~2s, nên gộp được nhóm nào thì dòng VI hiện sớm được nhóm đó — chờ thêm
    // chỉ làm bản dịch đến muộn mà không giúp gì cho quota.
    // `msUntilRoom()` đã bao gồm cả cooldown toàn cục — xem
    // TranslationRateLimiter.pauseUntil. Lấy max với `drainNotBefore` để
    // không thử lại trong lúc provider còn đang quá tải.
    const wait = Math.max(
      this.rateLimiter.msUntilRoom(),
      this.drainNotBefore - Date.now(),
      0,
    );

    if (wait > 0) console.debug('[translation-timing]', {
      event: 'wait', waitMs: wait, pendingCount: this.pending.size,
    });
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      void this.drain();
    }, wait);
  }

  /** Nhóm này đã bị giữ chờ 503 quá lâu chưa? Xem `TRANSIENT_HOLD_MAX_MS`. */
  private hasHeldTooLong(key: string, now: number): boolean {
    const since = this.heldSince.get(key);
    return since !== undefined && now - since >= TRANSIENT_HOLD_MAX_MS;
  }

  /**
   * Dịch mọi nhóm đang chờ trong MỘT request.
   *
   * Fire-and-forget: FR-5.2 cho phép VI đến muộn 1–3s, nên không được để HTTP
   * call chặn luồng `words`. Lỗi (hết quota, mạng, thiếu key) chỉ log — caption
   * EN phải chạy bất kể.
   */
  private currentGroup(group: CaptionGroup & { sourceId: string | null }): boolean {
    return !group.windowedGroupId || this.transcriptService.isCurrentWindowedGroup(group.sourceId, group.windowedGroupId, group.text);
  }

  private async drain(): Promise<void> {
    // Kiểm lại quota NGAY TRƯỚC khi tiêu, dù `scheduleDrain` đã tính rồi.
    // Đây là chốt chặn duy nhất nằm đúng chỗ request thật sự rời máy, nên bất
    // biến "≤15 request/60s" được giữ tại đây thay vì phụ thuộc vào việc timer
    // không bao giờ nổ sớm (đồng hồ hệ thống nhảy, timer bị dồn...). Trả batch về
    // hàng đợi rồi hẹn lại — không mất câu nào.
    if (this.rateLimiter.msUntilRoom() > 0) {
      this.scheduleDrain();
      return;
    }

    const batch = Array.from(this.pending.values()).filter(
      (g) =>
        this.currentGroup(g) && (!(g.windowedGroupId ?? g.captionId) ||
        !this.transcriptService.getTranslation(g.sourceId, (g.windowedGroupId ?? g.captionId)!)),
    );
    this.pending.clear();
    if (batch.length === 0) return;

    this.draining = true;
    const batchId = ++this.translationBatchSequence;
    const startedAt = Date.now();
    let sentCount = 0;
    let staleCount = 0;
    let emptyCount = 0;
    console.debug('[translation-timing]', { event: 'start', batchId,
      batchSize: batch.length,
      oldestQueueMs: Math.max(...batch.map(g => startedAt - (g.enqueuedAt ?? startedAt))),
    });
    batch.forEach((g) =>
      this.inFlight.add(queueKey(g.sourceId, g.captionStart, g.windowedGroupId ?? g.captionId)),
    );
    // Ghi mốc NGAY TRƯỚC khi bắn — đây là bộ đếm quota, phải khớp số request
    // thật đã rời máy, kể cả request rồi thất bại.
    this.rateLimiter.recordCall();
    try {
      const results = await this.translateService.translateBatch(
        batch.map((g) => g.text),
        'vi',
        'en',
      );

      console.debug('[translation-timing]', { event: 'provider-complete', batchId,
        elapsedMs: Date.now() - startedAt });
      batch.forEach((group, index) => {
        // Xoá mốc giữ NGAY khi thành công: để sót lại thì lần 503 sau nhóm này
        // bị coi là "đã giữ quá lâu" và bị bỏ oan.
        this.heldSince.delete(
          queueKey(group.sourceId, group.captionStart, group.windowedGroupId ?? group.captionId),
        );
        const vi = results[index]?.text.trim();
        if (!vi) { emptyCount++; return; }
        if (!this.currentGroup(group)) { staleCount++; return; }

        // `sourceId` lấy từ nhóm đã xếp hàng, KHÔNG phải `activeSourceId`:
        // drain có thể chạy vài giây sau khi user đã đổi sang video khác.
        this.transcriptService.setTranslation({
          captionStart: group.captionStart,
          captionId: group.captionId,
        windowedGroupId: group.windowedGroupId,
          text: group.text,
          vi,
          sourceId: group.sourceId,
        });
        if (
          group.sourceId === this.activeSourceId &&
          group.sessionId === this.activeScope?.sessionId &&
          group.generation === this.activeScope?.generation &&
          group.client === this.extensionClient
        ) {
          sentCount++;
          this.sendToExtension({
            type: 'translation',
            ...this.activeScope,
            captionStart: group.captionStart,
            captionId: group.captionId,
        windowedGroupId: group.windowedGroupId,
            sourceId: group.sourceId,
            text: group.text,
            vi,
          });
        }
      });
    } catch (error: unknown) {
      console.debug('[translation-timing]', { event: 'error', batchId,
        elapsedMs: Date.now() - startedAt,
        errorType: error instanceof Error ? error.name : 'unknown' });
      // Ba nhánh, KHÁC NHAU về hậu quả — xem `ProviderUnavailableError`.
      const now = Date.now();
      const quotaError =
        error instanceof ProviderUnavailableError && !error.retryable;
      const overloaded =
        error instanceof ProviderUnavailableError && error.retryable;
      // 503 đã giữ quá trần ⇒ bỏ (còn câu mới trong hàng đợi vẫn được thử).
      const heldTooLong = batch.some((g) =>
        this.hasHeldTooLong(
          queueKey(g.sourceId, g.captionStart, g.windowedGroupId ?? g.captionId),
          now,
        ),
      );

      if (quotaError) {
        // Lỗi quota: KHÔNG thuộc về câu nào cả, cả project đang cạn quota.
        // Trả các nhóm về hàng đợi và KHÔNG tăng `attempts` — đếm nó là công
        // của câu thì một đợt cạn quota kéo dài sẽ xoá sổ bản dịch của cả
        // video.
        // Cooldown nằm ở limiter dùng chung, nên đường HTTP cũng dừng theo.
        this.rateLimiter.pauseUntil(now + error.retryAfterMs);
        for (const group of batch) {
          if (!this.currentGroup(group)) continue;
          this.pending.set(
            queueKey(group.sourceId, group.captionStart, group.windowedGroupId ?? group.captionId),
            group,
          );
        }
        console.warn(
          `Translation paused ${Math.round(error.retryAfterMs / 1000)}s (quota), ` +
            `re-queued ${batch.length} sentences`,
        );
      } else if (overloaded && !heldTooLong) {
        // 503 = model quá tải: TẠM THỜI và không tiêu quota ⇒ giữ câu trong
        // hàng đợi, KHÔNG tính công, chờ provider hồi.
        //
        // Phải khai báo lịch nghỉ cho chính drain này (`drainNotBefore`),
        // không chỉ re-queue: cửa sổ quota vẫn còn chỗ sau 503 nên nếu không,
        // `scheduleDrain` hẹn 0ms và 503 lặp lại liên tục.
        this.drainNotBefore = Math.max(
          this.drainNotBefore,
          now + error.retryAfterMs,
        );
        for (const group of batch) {
          if (!this.currentGroup(group)) continue;
          const key = queueKey(
            group.sourceId,
            group.captionStart,
            group.windowedGroupId ?? group.captionId,
          );
          if (!this.heldSince.has(key)) {
            this.heldSince.set(key, now);
          }
          this.pending.set(key, group);
        }
        console.warn(
          `Translation held (provider overloaded), re-queued ${batch.length} sentences`,
        );
      } else {
        // Còn lại: lỗi của CHÍNH batch (400/401/500) — tính công rồi bỏ sau MAX
        // lần; hoặc 503 đã giữ quá `TRANSIENT_HOLD_MAX_MS`.
        for (const group of batch) {
          if (!this.currentGroup(group)) continue;
          const key = queueKey(
            group.sourceId,
            group.captionStart,
            group.windowedGroupId ?? group.captionId,
          );
          this.attempts.set(key, (this.attempts.get(key) ?? 0) + 1);
          this.heldSince.delete(key);
        }
        console.warn(
          `Translation batch skipped (${batch.length} sentences):`,
          error instanceof Error ? error.message : error,
        );
      }
    } finally {
      console.debug('[translation-timing]', { event: 'complete', batchId,
        elapsedMs: Date.now() - startedAt, sentCount, staleCount, emptyCount,
        pendingCount: this.pending.size });
      batch.forEach((g) =>
        this.inFlight.delete(queueKey(g.sourceId, g.captionStart, g.windowedGroupId ?? g.captionId)),
      );
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

  handleConnection(client: WebSocket) {
    console.info('Extension connected to audio WebSocket');
    this.extensionClient = client;
    this.activeScope = undefined;
    this.awaitingAudio = false;

    client.on('error', (err) => {
      console.error('Extension audio WebSocket error:', err);
    });

    client.on('message', (data: RawData, isBinary: boolean) => {
      if (client !== this.extensionClient) return;
      if (isBinary) {
        if (this.activeScope && !this.awaitingAudio) return;
        this.awaitingAudio = false;
        const buffer = toBuffer(data);
        if (this.activeScope && buffer.length !== 32000) return;
        this.sidecarService.sendAudio(buffer);
        return;
      }

      try {
        const parsed: unknown = JSON.parse(data.toString());
        if (isRecord(parsed) && (isScope(parsed) || this.activeScope)) {
          if (!isScope(parsed)) return;
          const control = [
            'source-switch',
            'seek',
            'source-language',
            'playback',
          ].includes(String(parsed.type));
          if (control) {
            if (
              parsed.type === 'seek' &&
              (!Number.isFinite(parsed.seekTimeAtCapture) ||
                Number(parsed.seekTimeAtCapture) < 0)
            )
              return;
            if (
              parsed.type === 'source-language' &&
              parsed.language !== null &&
              (typeof parsed.language !== 'string' ||
                !/^[a-z]{2,3}$/.test(parsed.language))
            )
              return;
            if (
              parsed.type === 'playback' &&
              !['paused', 'ended', 'playing'].includes(String(parsed.state))
            )
              return;
            if (!this.adoptScope(parsed)) return;
            this.awaitingAudio = false;
            this.videoClockService.reset();
            this.sidecarService.sendControl(
              parsed as CaptureScope & { type: string },
            );
            if (parsed.type === 'seek')
              this.replay(Number(parsed.seekTimeAtCapture));
          } else if (parsed.type === 'restore-snapshot') {
            if (!sameScope(this.activeScope, parsed)) return;
            if (
              this.transcriptService.restoreSnapshot(
                parsed,
                parsed.words,
                parsed.translations,
              )
            )
              this.replay(0);
          } else if (parsed.type === 'audio') {
            if (
              !sameScope(this.activeScope, parsed) ||
              parsed.frames !== 16000 ||
              parsed.sampleRate !== 16000 ||
              !Number.isSafeInteger(parsed.seq) ||
              !Number.isFinite(parsed.frameStartVideoTime) ||
              !Number.isFinite(parsed.videoTimeAtCapture) ||
              !Number.isFinite(parsed.capturedAtEpochMs)
            )
              return;
            const metadata =
              process.env.CAPTION_MODE === 'streaming'
                ? parsed
                : {
                    ...parsed,
                    videoTimeAtCapture: this.videoClockService.resolveAnchor(
                      Number(parsed.videoTimeAtCapture),
                    ),
                  };
            this.awaitingAudio = this.sidecarService.sendMetadata(metadata);
          }
          return;
        }
        if (isRecord(parsed) && parsed.type === 'source-switch') {
          const sourceId = (parsed as { sourceId?: string }).sourceId;
          if (typeof sourceId === 'string' && sourceId) {
            this.activeSourceId = sourceId;
            this.videoClockService.reset();
            // Nội dung video trước không được sống sót qua mốc đổi nguồn.
            this.sidecarService.sendSourceSwitch(sourceId);
          }
        } else if (isRecord(parsed) && parsed.type === 'seek') {
          const seekTime = (parsed as { seekTimeAtCapture?: number })
            .seekTimeAtCapture;
          if (seekTime !== undefined) {
            this.videoClockService.reset();

            // Reset clock ở backend là chưa đủ: sidecar còn giữ ~3s audio của
            // đoạn trước mốc tua, để nguyên thì window kế tiếp trộn tiếng cũ với
            // tiếng mới nhưng dán mốc mới ⇒ phụ đề đúng lúc tua rồi lệch ngay sau.
            this.sidecarService.sendReset();

            // Mốc thời gian là của RIÊNG video này, nên phải lọc theo nguồn.
            const sourceId = this.activeSourceId;

            // Lấy hết phần đã xem phía sau, không giới hạn cửa sổ: giới hạn thì
            // sau mốc đó hệ thống không biết đã xem tới đâu và rơi về nhịp
            // transcribe thường, dù dữ liệu nằm sẵn trong cache.
            const replayWords = this.transcriptService.getRangeFrom(
              sourceId,
              seekTime,
            );

            // Bản dịch đi kèm, thiếu chúng thì dòng VI rỗng ở đúng các đoạn tiếp theo.
            const replayTranslations =
              this.transcriptService.getTranslationsFrom(sourceId, seekTime);
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

  private adoptScope(scope: CaptureScope): boolean {
    const old = this.activeScope;
    if (
      old &&
      scope.sessionId === old.sessionId &&
      (scope.generation < old.generation ||
        (scope.generation === old.generation &&
          scope.sourceId !== old.sourceId))
    )
      return false;
    this.activeScope = {
      sessionId: scope.sessionId,
      generation: scope.generation,
      sourceId: scope.sourceId,
    };
    this.activeSourceId = scope.sourceId;
    this.transcriptService.setScope(this.activeScope);
    return true;
  }

  private replay(seekTime: number): void {
    this.sendToExtension({
      type: 'replay',
      ...this.activeScope,
      seekTime,
      ...(process.env.CAPTION_MODE === 'streaming'
        ? { words: this.transcriptService.getRangeFrom(this.activeSourceId, seekTime) }
        : this.transcriptService.getWindowedReplay(this.activeSourceId, seekTime)),
      translations: this.transcriptService.getTranslationsFrom(
        this.activeSourceId,
        seekTime,
      ),
      captions: this.transcriptService.getFinalizedCaptions(
        this.activeSourceId,
        seekTime,
      ),
    });
  }

  handleDisconnect(client?: WebSocket) {
    if (client && client !== this.extensionClient) return;
    console.info('Extension disconnected from audio WebSocket');
    this.extensionClient = undefined;
    this.awaitingAudio = false;
    this.activeScope = undefined;
  }
}

/**
 * Sidecar chốt nhóm caption bằng `captionStart` (gặp dấu kết câu hoặc đủ 16 từ).
 * Backend gom lại theo chính khoá đó — extension đã tự gom nhóm để dựng dòng EN,
 * nó chỉ thiếu bản dịch.
 */
function collectCaptionGroups(words: unknown): CaptionGroup[] {
  if (!Array.isArray(words)) return [];

  const groups = new Map<string, CaptionGroup>();
  for (const raw of words) {
    if (!isRecord(raw) || typeof raw.w !== 'string' || typeof raw.captionStart !== 'number') continue;
    const id = typeof raw.windowedGroupId === 'string' ? raw.windowedGroupId : undefined;
    const key = id ?? String(raw.captionStart);
    const group = groups.get(key);
    if (group) group.text += ` ${raw.w}`;
    else groups.set(key, { captionStart: raw.captionStart, text: raw.w, windowedGroupId: id });
  }
  return [...groups.values()];
}

function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(data));
  }

  return Buffer.from(data);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
