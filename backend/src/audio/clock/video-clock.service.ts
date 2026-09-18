import { Injectable } from '@nestjs/common';

@Injectable()
export class VideoClockService {
  /** Độ dài audio một chunk, giây (capture.ts: 16,000 mẫu @ 16kHz). */
  private static readonly CHUNK_SECONDS = 1.0;

  /** `videoTimeAtCapture` của chunk TRƯỚC. `undefined` = chưa có chunk nào. */
  private previous: number | undefined;

  /**
   * @param currentVideoTime `videoTimeAtCapture` offscreen vừa gửi
   * @returns video time tại thời điểm BẮT ĐẦU audio của chunk này
   */
  resolveAnchor(currentVideoTime: number): number {
    //  - Đã có chunk trước → dùng mẫu của chunk trước.
    //  - Chunk đầu tiên → chưa có mẫu, suy ra: video time lùi đúng CHUNK_SECONDS.
    const anchor =
      this.previous !== undefined
        ? this.previous
        : currentVideoTime - VideoClockService.CHUNK_SECONDS;

    // Cập nhật SAU khi đã tính anchor — thứ tự này quan trọng.
    this.previous = currentVideoTime;
    return anchor;
  }

  /** Xoá trạng thái — gọi khi seek */
  reset(): void {
    this.previous = undefined;
  }
}
