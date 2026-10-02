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
 */
export class ProviderUnavailableError extends Error {
  /** Server dặn chờ bao lâu. Đã lấy từ `retryDelay`, KHÔNG bị cap. */
  readonly retryAfterMs: number;

  /**
   * Mặc định false = coi lỗi là quota của CẢ PROJECT, nên giữ câu và dừng mọi
   * request; chỉ lỗi tạm thời thuộc batch (503) truyền true.
   */
  readonly retryable: boolean;

  constructor(message: string, retryAfterMs: number, retryable = false) {
    super(message);
    this.name = 'ProviderUnavailableError';
    this.retryAfterMs = retryAfterMs;
    this.retryable = retryable;
  }
}
