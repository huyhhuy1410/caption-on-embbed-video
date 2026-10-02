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

  it('blocks on cooldown even when the sliding window has room', () => {
    // Hồi quy cho Issue 5.16: cửa sổ còn trống (0 request) KHÔNG được phép
    // bỏ qua cooldown — nếu không thì `pauseUntil` là dòng code chết và đường
    // khác tiếp tục bắn provider trong khi nó đã báo hết quota.
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

    // Cửa sổ mở lại ở 60s nhưng provider còn bảo chờ tới 80s ⇒ phải chờ 80s.
    expect(limiter.msUntilRoom(1_000)).toBe(79_000);
  });
});
