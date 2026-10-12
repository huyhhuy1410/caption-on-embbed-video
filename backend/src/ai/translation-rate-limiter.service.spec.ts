import { TranslationRateLimiter } from './translation-rate-limiter.service';

describe('TranslationRateLimiter', () => {
  let limiter: TranslationRateLimiter;

  beforeEach(() => {
    limiter = new TranslationRateLimiter();
  });

  it('allows requests while the window has room', () => {
    expect(limiter.msUntilRoom(0)).toBe(0);
    limiter.recordCall(0);
    expect(limiter.callsInWindow(0)).toBe(1);
    expect(limiter.msUntilRoom(1_000)).toBe(0);
  });

  it('blocks once the window is full and reopens when the oldest expires', () => {
    for (let i = 0; i < 15; i++) limiter.recordCall(i);

    // Exactly full at 15 ⇒ wait until the oldest request (t=0) falls out.
    expect(limiter.msUntilRoom(1_000)).toBe(59_000);
    expect(limiter.msUntilRoom(59_999)).toBe(1);
    expect(limiter.msUntilRoom(60_001)).toBe(0);
  });

  it('keeps the invariant under a burst then a long gap', () => {
    // 15 requests in 1 second, then 2 minutes of silence — the sliding window must
    // reopen on its own, which interval-based throttling cannot do.
    for (let i = 0; i < 15; i++) limiter.recordCall(i);

    expect(limiter.msUntilRoom(500)).toBeGreaterThan(0);
    expect(limiter.callsInWindow(120_000)).toBe(0);
    expect(limiter.msUntilRoom(120_000)).toBe(0);
  });

  it('blocks on cooldown even when the sliding window has room', () => {
    // Regression for Issue 5.16: an empty window (0 requests) must NOT bypass the
    // cooldown — otherwise `pauseUntil` is dead code and other paths keep hitting
    // the provider after it reported quota exhaustion.
    limiter.pauseUntil(10_000);

    expect(limiter.msUntilRoom(0)).toBe(10_000);
    expect(limiter.msUntilRoom(9_999)).toBe(1);
    expect(limiter.msUntilRoom(10_001)).toBe(0);
  });

  it('never shortens a cooldown that is already running', () => {
    limiter.pauseUntil(30_000);
    limiter.pauseUntil(5_000);

    expect(limiter.msUntilRoom(0)).toBe(30_000);
  });

  it('takes the longer of the cooldown and the sliding window', () => {
    for (let i = 0; i < 15; i++) limiter.recordCall(i);
    limiter.pauseUntil(80_000);

    // The window reopens at 60s but the provider asked to wait until 80s ⇒ wait 80s.
    expect(limiter.msUntilRoom(1_000)).toBe(79_000);
  });
});
