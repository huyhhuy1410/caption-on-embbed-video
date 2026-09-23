/**
 * Provider tạm thời KHÔNG phục vụ được — nhưng lỗi không thuộc về request nào
 * cả. Ví dụ điển hình: 429 hết quota, vốn là trạng thái của CẢ PROJECT trong
 * cửa sổ một phút.
 *
 * Vì sao cần phân biệt: retry cùng request đó trong cùng phút là vô ích (quota
 * chưa mở lại), còn đếm nó là "câu này hỏng" thì lại oan cho câu đó và làm mất
 * bản dịch vĩnh viễn. Tầng gọi phải biết để tạm dừng MỌI request rồi thử lại
 * sau.
 */
export class ProviderUnavailableError extends Error {
  /** Server dặn chờ bao lâu. Đã lấy từ `retryDelay`, KHÔNG bị cap. */
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'ProviderUnavailableError';
    this.retryAfterMs = retryAfterMs;
  }
}
