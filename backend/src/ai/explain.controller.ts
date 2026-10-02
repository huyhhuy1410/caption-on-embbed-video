import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ExplainService } from './explain.service';
import { TranslationRateLimiter } from './translation-rate-limiter.service';
import { ProviderUnavailableError } from './errors';
import { ExplainWordDto } from './dto/explain-word.dto';

@Controller('explain-word')
export class ExplainController {
  constructor(
    private readonly explainService: ExplainService,
    private readonly rateLimiter: TranslationRateLimiter,
  ) {}

  @Post()
  async explainWord(@Body() body: ExplainWordDto) {
    // ⚠️ Endpoint này dùng CHUNG Gemini instance (và CHUNG quota 15 req/phút) với
    // /translate và đường caption, nên phải đi qua cùng bộ đếm — xem
    // TranslationRateLimiter. Ghi ở TẦNG GỌI, không ở ExplainService,
    // để không đếm trùng. Hết chỗ thì trả 429 ngay (HTTP, client tự thử lại),
    // không xếp hàng chờ.
    const waitMs = this.rateLimiter.tryAcquire();
    if (waitMs > 0) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message:
            'Explain rate limit reached (15 requests per minute). ' +
            `Retry in ${Math.ceil(waitMs / 1000)}s.`,
          retryAfterMs: waitMs,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    try {
      return await this.explainService.explainWord(body);
    } catch (error: unknown) {
      if (error instanceof ProviderUnavailableError) {
        if (!error.retryable) {
          // Hết quota ⇒ trạng thái của CẢ PROJECT. Đẩy cooldown vào bộ đếm
          // dùng chung để /translate và đường caption cũng dừng theo.
          this.rateLimiter.pauseUntil(Date.now() + error.retryAfterMs);
          throw new HttpException(
            {
              statusCode: HttpStatus.TOO_MANY_REQUESTS,
              message: 'Explain provider quota exhausted.',
              retryAfterMs: error.retryAfterMs,
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        // 503 = model quá tải ⇒ lỗi của CHÍNH request này, không phải quota của
        // project ⇒ trả 503 và KHÔNG pause bộ đếm chung.
        throw new HttpException(
          {
            statusCode: HttpStatus.SERVICE_UNAVAILABLE,
            message: 'Explain provider temporarily overloaded.',
          },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      throw error;
    }
  }
}
