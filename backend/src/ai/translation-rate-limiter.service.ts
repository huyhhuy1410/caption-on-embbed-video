import { Injectable } from '@nestjs/common';

/**
 * Trần số request dịch trong cửa sổ trượt một phút.
 *
 * Gemini free tier cho 15 request/phút (`quotaValue: 15` trong chính response
 * 429). Đây là giá trị MẶC ĐỊNH và phải giữ nguyên khi dùng `AI_PROVIDER=gemini`.
 *
 * Với provider KHÁC (CommandCode) con số này không phải trần thật của hạ tầng
 * — tài liệu CommandCode không công bố RPM. Nhưng bộ đếm này không phải để
 * phòng thủ provider, mà để giữ ĐỦ NHỊP: hệ thống sinh ~15–25 nhóm caption mỗi
 * phút, và mỗi lượt drain là MỘT request ⇒ con số này quyết định caption có kịp
 * theo video hay không. Nâng lên sẽ giữ được nhịp dịch với provider chịu được
 * thêm, nên cho phép ghi đè bằng env `AI_MAX_RPM`.
 *
 * Nếu nâng quá trần thật của provider thì hậu quả KHÔNG phải mất bản dịch:
 * provider trả 429 ⇒ `ProviderUnavailableError(retryable = false)` ⇒ gateway
 * tự pause toàn bộ theo `retryAfterMs`. Tức là bộ đếm hơi thừa chỉ tốn một
 * vòng 429, còn thấp hơn thật thì caption trễ. Vì vậy hợp lý là hơi cao.
 */
export const TRANSLATE_MAX_PER_WINDOW = readMaxRpm();

/** Đọc `AI_MAX_RPM`; rơi về 15 khi thiếu / rác / không phải số dương. */
function readMaxRpm(): number {
  const raw = process.env.AI_MAX_RPM;
  if (!raw) return 15;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 15;
}

/** Độ dài cửa sổ quota — quota của Gemini là PER MINUTE. */
export const TRANSLATE_WINDOW_MS = 60_000;

/**
 * Bộ đếm quota dịch — nguồn sự thật DUY NHẤT về số request đã bắn.
 *
 * Vì sao phải là service dùng chung chứ không phải biến riêng của gateway:
 * quota thuộc về **project**, không thuộc về đường vào nào. Có hai đường gọi
 * provider — `AudioGateway` (caption, qua WebSocket) và `TranslateController`
 * (HTTP `/translate`) — nên nếu mỗi bên tự đếm thì trần thật là *tổng* của hai
 * bộ đếm, và mỗi bên đều tưởng mình đang trong trần. Đó đúng là lỗi mà Issue
 * 5.14 vừa fix, chỉ ở dạng khác.
 *
 * Chỉ ghi nhận ở TẦNG GỌI (gateway / controller), không nhồi vào
 * `TranslateService`. Nhét vào tầng service là đếm hai lần cho đường caption,
 * vì gateway đã gọi `recordCall()` rồi mới gọi `translateBatch()`.
 */
@Injectable()
export class TranslationRateLimiter {
  /** Mốc thời gian của từng request đã bắn, trong cửa sổ 60s gần nhất. */
  private readonly callTimes: number[] = [];

  /**
   * Mốc thời gian được phép gọi lại sau khi provider báo hết quota.
   *
   * Nằm ở ĐÂY chứ không ở gateway: hết quota là trạng thái của cả project, nên
   * một đường phát hiện ra (HTTP hay WebSocket) thì đường kia cũng phải dừng. Để
   * riêng trong gateway thì request HTTP gặp 429 vẫn không ngăn được caption
   * tiếp tục đốt quota.
   */
  private cooldownUntil = 0;

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
    // Cooldown phải được kiểm TRA TRƯỚC khi xét cửa sổ trượt. Trả sớm "còn
    // chỗ" khi cửa sổ chưa đầy thì bỏ qua cooldown ⇒ `pauseUntil()` trở thành
    // một dòng code chết và đường khác vẫn đốt quota. Đã xảy ra.
    const byCooldown = Math.max(0, this.cooldownUntil - now);
    if (byCooldown > 0) return byCooldown;

    const live = this.trim(now);
    if (live.length < TRANSLATE_MAX_PER_WINDOW) return 0;

    const oldest = live[0];
    return Math.max(0, oldest + TRANSLATE_WINDOW_MS - now);
  }

  /**
   * Tạm dừng MỌI request tới một mốc thời gian, sau khi provider báo hết quota.
   *
   * Chỉ dùng cho lỗi quota (`retryable = false`). Giữ nguyên `retryAfterMs`
   * server dặn, không cap — xem `serverRetryDelayMs`.
   */
  pauseUntil(untilMs: number): void {
    this.cooldownUntil = Math.max(this.cooldownUntil, untilMs);
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
   * Xin một suất: còn chỗ thì ghi nhận luôn và trả 0; hết chỗ thì trả số ms
   * phải chờ.
   *
   * Gộp kiểm-tra và ghi-nhận vào MỘT lời gọi là chủ ý. Tách thành
   * `msUntilRoom()` rồi `recordCall()` ở tầng gọi là mở khoảng hở: hai caller
   * cùng thấy "còn chỗ" trước khi ai kịp ghi, và cả hai cùng bắn. Hàm này chạy
   * đồng bộ từ đầu tới cuối nên không có `await` nào chen vào giữa.
   *
   * Dùng cho đường HTTP, nơi hết chỗ thì từ chối ngay. Đường WebSocket không
   * dùng hàm này vì nó cần *hẹn giờ* chứ không từ chối — xem `msUntilRoom()`.
   */
  tryAcquire(now: number = Date.now()): number {
    const wait = this.msUntilRoom(now);
    if (wait > 0) return wait;

    this.recordCall(now);
    return 0;
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
