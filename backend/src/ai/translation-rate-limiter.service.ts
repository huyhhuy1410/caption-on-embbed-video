import { Injectable } from '@nestjs/common';

/**
 * Trần số request dịch trong cửa sổ trượt một phút.
 *
 * Gemini free tier cho 15 request/phút (`quotaValue: 15` trong chính response
 * 429). Đây là con số DUY NHẤT phải giữ.
 */
export const TRANSLATE_MAX_PER_WINDOW = 15;

/** Độ dài cửa sổ quota — quota của Gemini là PER MINUTE. */
export const TRANSLATE_WINDOW_MS = 60_000;

/**
 * Bộ đếm quota dịch — nguồn sự thật DUY NHẤT về số request đã bắn.
 *
 * ⚠️ Vì sao phải là service dùng chung chứ không phải biến riêng của gateway:
 * quota thuộc về **project**, không thuộc về đường vào nào. Có hai đường gọi
 * provider — `AudioGateway` (caption, qua WebSocket) và `TranslateController`
 * (HTTP `/translate`) — nên nếu mỗi bên tự đếm thì trần thật là *tổng* của hai
 * bộ đếm, và mỗi bên đều tưởng mình đang trong trần. Đó đúng là lỗi mà Issue
 * 5.14 vừa fix, chỉ ở dạng khác.
 *
 * ⚠️ Chỉ ghi nhận ở TẦNG GỌI (gateway / controller), không nhồi vào
 * `TranslateService`. Nhét vào tầng service là đếm hai lần cho đường caption,
 * vì gateway đã gọi `recordCall()` rồi mới gọi `translateBatch()`.
 */
@Injectable()
export class TranslationRateLimiter {
  /** Mốc thời gian của từng request đã bắn, trong cửa sổ 60s gần nhất. */
  private readonly callTimes: number[] = [];

  /**
   * Còn bao lâu nữa thì cửa sổ mới có chỗ cho một request.
   *
   * Trả 0 nếu còn chỗ. Nếu đã đầy, trả đúng khoảng thời gian để request CŨ NHẤT
   * rơi ra ngoài — lúc đó quota mới thật sự mở lại.
   *
   * Đây là chỗ hiện thực hoá "quota là per MINUTE": không có cách nào thử nhanh
   * hơn, vì cửa sổ của provider trượt theo thời gian chứ không reset theo lượt.
   */
  msUntilRoom(now: number = Date.now()): number {
    const live = this.trim(now);
    if (live.length < TRANSLATE_MAX_PER_WINDOW) return 0;

    const oldest = live[0];
    return Math.max(0, oldest + TRANSLATE_WINDOW_MS - now);
  }

  /**
   * Ghi nhận MỘT request sắp rời máy.
   *
   * Gọi ngay TRƯỚC khi bắn, kể cả request rồi thất bại — request hỏng vẫn tiêu
   * quota của provider.
   */
  recordCall(now: number = Date.now()): void {
    this.callTimes.push(now);
  }

  /** Số request đang tính trong cửa sổ — dùng cho test và log. */
  callsInWindow(now: number = Date.now()): number {
    return this.trim(now).length;
  }

  /**
   * Bỏ các mốc đã rơi ra ngoài cửa sổ, trả về danh sách còn sống.
   *
   * Mỗi lần gọi cũng là một lần dọn rác, nên mảng không phình theo thời gian.
   */
  private trim(now: number): number[] {
    const live = this.callTimes.filter((at) => at > now - TRANSLATE_WINDOW_MS);
    this.callTimes.length = 0;
    this.callTimes.push(...live);
    return live;
  }
}
