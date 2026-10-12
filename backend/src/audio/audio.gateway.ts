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

/** Windowed uses timestamps; streaming uses stable identity. */
type CaptionGroup = { captionStart: number; text: string; captionId?: string; windowedGroupId?: string };

/** Queue key = (source, captionStart). Without the source, two videos at 0:00 collide (Issue 5.20). */
function queueKey(
  sourceId: string | null,
  captionStart: number,
  captionId?: string,
): string {
  return captionId
    ? captionKey(sourceId, captionId)
    : `${sourceId ?? ''}|${captionStart}`;
}

/** Group with source attached, used when queuing for translation. See `enqueueForTranslation`. */
type QueuedGroup = CaptionGroup & {
  sourceId: string | null;
  sessionId?: string;
  generation?: number;
  client?: WebSocket;
  enqueuedAt?: number;
};

/** Max attempts per sentence before dropping it. */
const MAX_TRANSLATE_ATTEMPTS = 3;

/**
 * Max time to hold a sentence during 503 overload. Holding is safe — 503 doesn't consume
 * quota — and keeps a brief provider outage from deleting a whole video's translations,
 * which the old count-and-drop path did (Issue 5.12). The ceiling bounds the hold.
 */
const TRANSIENT_HOLD_MAX_MS = 5 * 60_000;

@WebSocketGateway()
export class AudioGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private extensionClient?: WebSocket;

  /**
   * `sourceId` of the currently playing video. Session-lifetime, not per-message:
   * tabCapture delivers audio from every video in the tab, so seek/replay must know
   * which source to read. Stale value returns the previous video's words (Issue 5.20).
   */
  private activeSourceId: string | null = null;
  private activeScope?: CaptureScope;
  private awaitingAudio = false;
  private readonly inFlight = new Set<string>();

  /** Value is `QueuedGroup` — must keep `sourceId` so drain writes to correct source cache. */
  private readonly pending = new Map<string, QueuedGroup>();

  private drainTimer: ReturnType<typeof setTimeout> | undefined;

  private draining = false;
  private translationBatchSequence = 0;

  /** Attempt count per group, to stop retrying after MAX_TRANSLATE_ATTEMPTS. */
  private readonly attempts = new Map<string, number>();

  /** When a group started being held for 503 — wait TIME, unlike `attempts` which counts. */
  private readonly heldSince = new Map<string, number>();

  /**
   * Don't retry before this timestamp after a 503 burst. Needed separately because
   * `msUntilRoom()` only knows quota: the window still has room right after a 503, so
   * the timer would fire at 0ms and 503 forever. Owned here, not by the shared limiter,
   * because 503 is request-specific — the HTTP path has no reason to stall.
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
      // Sidecar keeps state per WS connection; reconnect = buffer/source cleared.
      // Resend CURRENT source so first window after reload goes to correct namespace.
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
   * Queue caption groups that lack translations, then schedule a drain. Queuing rather
   * than calling directly: one request per sentence exceeds the Gemini free tier
   * (~15-25 groups/min against 15 RPM), so several sentences must share one request.
   * Enqueue is synchronous and `drain` runs in the next macrotask, so groups arriving in
   * the same `words` message batch together for free.
   */
  private enqueueForTranslation(groups: CaptionGroup[]): void {
    for (const group of groups) {
      const cached = this.transcriptService.getTranslation(
        this.activeSourceId,
        group.windowedGroupId ?? group.captionId ?? group.captionStart,
      );
      // Compare TEXT, not just key: a group can grow across a window boundary (half
      // sentence first, full sentence next), and a key-only hit would keep the half.
      if (cached && cached.text === group.text) {
        this.sendToExtension({ type: 'translation', ...cached, ...this.activeScope });
        continue;
      }

      // Capture the source AT QUEUE TIME: drain runs seconds later, and a video switch
      // in between would file this translation under the new video (Issue 5.20).
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

      // Overwrite: group may already be queued with OLD (shorter) text, now longer. Latest is correct.
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
   * Schedule the next drain, waiting until the quota window has room. The `draining`
   * guard is load-bearing: `drainTimer` is cleared when the timer FIRES, not when the
   * drain COMPLETES, so a draining request that awaits for seconds leaves `drainTimer`
   * undefined and would let a second drain start against the same quota bucket.
   */
  private scheduleDrain(): void {
    if (this.pending.size === 0) return;
    if (this.drainTimer !== undefined || this.draining) return;

    // Fire as soon as the window has room. Captions arrive in ~2s bursts, so draining
    // whatever is queued shows VI sooner; waiting longer only delays it.
    // `drainNotBefore` keeps a waiting drain from retrying while the provider is down.
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

  /** Has this group been held for 503 too long? See `TRANSIENT_HOLD_MAX_MS`. */
  private hasHeldTooLong(key: string, now: number): boolean {
    const since = this.heldSince.get(key);
    return since !== undefined && now - since >= TRANSIENT_HOLD_MAX_MS;
  }

  /** Group is still the active one for its source, so its translation is worth keeping. */
  private currentGroup(group: CaptionGroup & { sourceId: string | null }): boolean {
    return !group.windowedGroupId || this.transcriptService.isCurrentWindowedGroup(group.sourceId, group.windowedGroupId, group.text);
  }

  /**
   * Translate all waiting groups in ONE request, fire-and-forget: FR-5.2 tolerates VI
   * arriving 1-3s late, so the HTTP call must not block the `words` stream. Every failure
   * is handled in the catch — EN captions run regardless.
   */
  private async drain(): Promise<void> {
    // Recheck quota immediately before spending. This is the last checkpoint before the
    // request leaves, so "≤15 requests/60s" holds even if the timer fired early. Groups
    // go back on the queue, so nothing is lost.
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
    // Count right before sending: this feeds the quota window and must reflect requests
    // actually issued, including ones that fail.
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
        // Clear the hold timestamp on success — leaving it would make the next 503 read
        // this group as held-too-long and drop it.
        this.heldSince.delete(
          queueKey(group.sourceId, group.captionStart, group.windowedGroupId ?? group.captionId),
        );
        const vi = results[index]?.text.trim();
        if (!vi) { emptyCount++; return; }
        if (!this.currentGroup(group)) { staleCount++; return; }

        // `sourceId` off the queued group, never `activeSourceId` — the user may have
        // switched videos since this was queued.
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
      const now = Date.now();
      const quotaError =
        error instanceof ProviderUnavailableError && !error.retryable;
      const overloaded =
        error instanceof ProviderUnavailableError && error.retryable;
      // A 503 held past the ceiling drops like any other error; newly queued sentences still get their turn.
      const heldTooLong = batch.some((g) =>
        this.hasHeldTooLong(
          queueKey(g.sourceId, g.captionStart, g.windowedGroupId ?? g.captionId),
          now,
        ),
      );

      if (quotaError) {
        // Project-wide, not any sentence's fault. Re-queue WITHOUT counting an attempt —
        // charging it to the sentence would delete the whole video's translations once
        // quota runs dry. The shared limiter's cooldown also stalls the HTTP path.
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
        // Model overload: temporary and quota-free, so hold without counting an attempt.
        // `drainNotBefore` must be set, not just a re-queue — the quota window still has
        // room after a 503, so `scheduleDrain` would otherwise retry at 0ms and 503 forever.
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
        // Batch-specific failure (400/401/500), or a 503 held past `TRANSIENT_HOLD_MAX_MS`:
        // count the attempt and drop the sentence once `MAX_TRANSLATE_ATTEMPTS` is spent.
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
      // New groups may have arrived while waiting for this request.
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
            // Previous video content must not survive source switch point.
            this.sidecarService.sendSourceSwitch(sourceId);
          }
        } else if (isRecord(parsed) && parsed.type === 'seek') {
          const seekTime = (parsed as { seekTimeAtCapture?: number })
            .seekTimeAtCapture;
          if (seekTime !== undefined) {
            this.videoClockService.reset();

            // Resetting the backend clock isn't enough — the sidecar still holds ~3s of
            // audio from before the seek, which would mix into the next window with the
            // new timestamps and leave captions briefly off-target.
            this.sidecarService.sendReset();

            // Timestamps are per-video, so replay must be filtered by source.
            const sourceId = this.activeSourceId;

            // Send everything watched after the seek point, unbounded: capping it would
            // re-introduce the ~2s transcribe latency for data already in cache.
            const replayWords = this.transcriptService.getRangeFrom(
              sourceId,
              seekTime,
            );

            // Translations travel alongside; without them the VI line is empty downstream.
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
          // Re-anchor: video time at START of this audio chunk, not at send time. See VideoClockService.
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
 * Regroup words into the captions the sidecar finalized (sentence-ending punctuation or
 * 16 words). The extension already grouped them to draw the EN line; this only needs the
 * per-caption text to translate.
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
