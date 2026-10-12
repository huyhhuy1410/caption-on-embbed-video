import { Injectable } from '@nestjs/common';

/**
 * Max translation requests per sliding window — the Gemini free-tier ceiling by default.
 * Also paces other providers, since the system produces ~15-25 caption groups/min.
 * Override with `AI_MAX_RPM`; going slightly over is safe because a 429 triggers a pause.
 */
export const TRANSLATE_MAX_PER_WINDOW = readMaxRpm();

/** Read `AI_MAX_RPM`; defaults to 15 if missing/invalid. */
function readMaxRpm(): number {
  const raw = process.env.AI_MAX_RPM;
  if (!raw) return 15;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 15;
}

/** Quota window duration — Gemini quota is per minute. */
export const TRANSLATE_WINDOW_MS = 60_000;

/**
 * Single source of truth for request count, shared rather than gateway-private
 * because quota is project-wide: both the WS gateway and the HTTP controller spend
 * it, and separate counters would blow the real limit (Issue 5.14). Callers record.
 */
@Injectable()
export class TranslationRateLimiter {
  /** Timestamps of recent requests within the 60s window. */
  private readonly callTimes: number[] = [];

  /** Cooldown after quota exhaustion — shared so the HTTP and WS paths pause together. */
  private cooldownUntil = 0;

  /**
   * Ms until the window has room for one request: 0 when there is room, otherwise
   * until the oldest request ages out. Sliding-window quota.
   */
  msUntilRoom(now: number = Date.now()): number {
    // Check cooldown BEFORE the window: returning "has room" early would bypass
    // cooldown entirely and make `pauseUntil()` dead code.
    const byCooldown = Math.max(0, this.cooldownUntil - now);
    if (byCooldown > 0) return byCooldown;

    const live = this.trim(now);
    if (live.length < TRANSLATE_MAX_PER_WINDOW) return 0;

    const oldest = live[0];
    return Math.max(0, oldest + TRANSLATE_WINDOW_MS - now);
  }

  /** Pause every request until `untilMs` after quota exhaustion (retryable = false), keeping the server's delay uncapped. */
  pauseUntil(untilMs: number): void {
    this.cooldownUntil = Math.max(this.cooldownUntil, untilMs);
  }

  /** Record an outgoing request BEFORE sending it — a failed request still spends quota. */
  recordCall(now: number = Date.now()): void {
    this.callTimes.push(now);
  }

  /** Request count in the current window — for testing and logging. */
  callsInWindow(now: number = Date.now()): number {
    return this.trim(now).length;
  }

  /**
   * Acquire a slot: 0 and a recorded call when there is room, else ms to wait.
   * Check and record are atomic — two callers must not both see room before either
   * records. The HTTP path uses this to reject immediately; the WS path uses
   * `msUntilRoom()` to reschedule instead.
   */
  tryAcquire(now: number = Date.now()): number {
    const wait = this.msUntilRoom(now);
    if (wait > 0) return wait;

    this.recordCall(now);
    return 0;
  }

  /** Remove expired timestamps, return remaining. Also garbage-collects array. */
  private trim(now: number): number[] {
    const live = this.callTimes.filter((at) => at > now - TRANSLATE_WINDOW_MS);
    this.callTimes.length = 0;
    this.callTimes.push(...live);
    return live;
  }
}
