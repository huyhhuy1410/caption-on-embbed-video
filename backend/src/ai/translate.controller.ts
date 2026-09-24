import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { TranslateService } from './translate.service';
import { TranslationRateLimiter } from './translation-rate-limiter.service';
import { TranslateDto } from './dto/translate.dto';

@Controller('translate')
export class TranslateController {
  constructor(
    private readonly translateService: TranslateService,
    private readonly rateLimiter: TranslationRateLimiter,
  ) {}
  @Post()
  async translate(@Body() body: TranslateDto) {
    // ⚠️ Endpoint này dùng CHUNG trần quota với đường caption (WebSocket), nên
    // phải hỏi bộ đếm dùng chung trước khi gọi provider — xem
    // TranslationRateLimiter. Không kiểm tra ở đây thì một caller HTTP có thể
    // đẩy tổng số request vượt trần mà gateway không hề biết (Issue 5.14).
    //
    // Trả 429 ngay thay vì xếp hàng chờ: đây là HTTP, client tự quyết định thử
    // lại; giữ connection treo tới 60s thì tệ hơn nhiều.
    const waitMs = this.rateLimiter.msUntilRoom();
    if (waitMs > 0) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message:
            'Translation rate limit reached (15 requests per minute). ' +
            `Retry in ${Math.ceil(waitMs / 1000)}s.`,
          retryAfterMs: waitMs,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    this.rateLimiter.recordCall();
    return this.translateService.translate(body);
  }
}
