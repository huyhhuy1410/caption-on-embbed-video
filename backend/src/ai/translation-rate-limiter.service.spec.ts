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

    // Đầy đúng 15 ⇒ phải chờ tới khi request cũ nhất (t=0) rơi ra ngoài.
    expect(limiter.msUntilRoom(1_000)).toBe(59_000);
    expect(limiter.msUntilRoom(59_999)).toBe(1);
    expect(limiter.msUntilRoom(60_001)).toBe(0);
  });

  it('keeps the invariant under a burst then a long gap', () => {
    // Bắn 15 request trong 1 giây, rồi im 2 phút — cửa sổ trượt phải tự mở lại,
    // đây là điều mà throttle-theo-khoảng-cách không làm được.
    for (let i = 0; i < 15; i++) limiter.recordCall(i);

    expect(limiter.msUntilRoom(500)).toBeGreaterThan(0);
    expect(limiter.callsInWindow(120_000)).toBe(0);
    expect(limiter.msUntilRoom(120_000)).toBe(0);
  });
});
