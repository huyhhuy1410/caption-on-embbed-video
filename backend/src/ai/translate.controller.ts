import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { TranslateService } from './translate.service';
import {
  TranslationRateLimiter,
  TRANSLATE_MAX_PER_WINDOW,
} from './translation-rate-limiter.service';
import { ProviderUnavailableError } from './errors';
import { TranslateDto } from './dto/translate.dto';

@Controller('translate')
export class TranslateController {
  constructor(
    private readonly translateService: TranslateService,
    private readonly rateLimiter: TranslationRateLimiter,
  ) {}
  @Post()
  async translate(@Body() body: TranslateDto) {
    // Shared quota with WebSocket caption path — check before calling provider.
    // Return 429 immediately (HTTP); client decides whether to retry.
    const waitMs = this.rateLimiter.tryAcquire();
    if (waitMs > 0) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message:
            `Translation rate limit reached (${TRANSLATE_MAX_PER_WINDOW} ` +
            `requests per minute). Retry in ${Math.ceil(waitMs / 1000)}s.`,
          retryAfterMs: waitMs,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    try {
      return await this.translateService.translate(body);
    } catch (error: unknown) {
      // Quota error = project-wide state. Apply cooldown to shared limiter (stops WebSocket too),
      // return 429 (not 500) so client knows how long to wait.
      if (error instanceof ProviderUnavailableError && !error.retryable) {
        this.rateLimiter.pauseUntil(Date.now() + error.retryAfterMs);
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: 'Translation provider quota exhausted.',
            retryAfterMs: error.retryAfterMs,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw error;
    }
  }
}
