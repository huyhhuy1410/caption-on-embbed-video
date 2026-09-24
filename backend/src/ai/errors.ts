/**
 * Provider tạm thời KHÔNG phục vụ được — nhưng chưa chắc lỗi thuộc về request
 * nào. Cờ `retryable` nói CHÍNH XÁC điều đó, và tầng gọi PHẢI rẽ nhánh theo nó.
 *
 * Vì sao cần phân biệt hai loại:
 * - **429 hết quota** (`retryable = false`): trạng thái của CẢ PROJECT trong cửa
 *   sổ một phút. Retry cùng request trong cùng phút là vô ích, và đếm nó là "câu
 *   này hỏng" thì oan cho câu đó, làm mất bản dịch vĩnh viễn ⇒ phải tạm dừng MỌI
 *   request rồi thử lại sau, giữ nguyên câu trong hàng đợi.
 * - **503 model quá tải** (`retryable = true`): thuộc về chính request đó ⇒ thử
 *   lại đúng batch đó là hợp lý, nhưng phải TÍNH CÔNG để một đợt quá tải kéo dài
 *   không giữ câu trong hàng đợi mãi mãi.
 *
 * ⚠️ Gộp hai loại này vào một nhánh là công thức tạo bão request — đã xảy ra một
 * lần rồi (Issue 5.12).
 */
export class ProviderUnavailableError extends Error {
  /** Server dặn chờ bao lâu. Đã lấy từ `retryDelay`, KHÔNG bị cap. */
  readonly retryAfterMs: number;

  /**
   * Lỗi có thuộc về chính batch này không (xem giải thích ở trên).
   *
   * Mặc định `false` — tức coi lỗi là của CẢ PROJECT. Đây là mặc định đúng vì
   * hai lý do:
   * 1. Giữ nguyên nghĩa của constructor hai tham số đã có trong code commit
   *    (hồi đó MỌI `ProviderUnavailableError` đều được re-queue như lỗi quota).
   *    Đổi mặc định là âm thầm đổi hành vi của mọi chỗ gọi cũ.
   * 2. Hai hướng sai không cân nhau: re-queue nhầm chỉ làm bản dịch đến muộn
   *    (vẫn có cooldown chặn), còn tính công nhầm sẽ BỎ VĨNH VIỄN bản dịch sau 3
   *    lần — đúng thứ đã xoá sổ bản dịch cả video ở Issue 5.12.
   *
   * 503 truyền `true` tường minh.
   */
  readonly retryable: boolean;

  constructor(message: string, retryAfterMs: number, retryable = false) {
    super(message);
    this.name = 'ProviderUnavailableError';
    this.retryAfterMs = retryAfterMs;
    this.retryable = retryable;
  }
}
