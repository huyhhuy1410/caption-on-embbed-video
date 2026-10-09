import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ExplainService } from './explain.service';
import { ExplainCacheService } from './explain-cache.service';
import {
  TranslationRateLimiter,
  TRANSLATE_MAX_PER_WINDOW,
} from './translation-rate-limiter.service';
import { ProviderUnavailableError } from './errors';
import { ExplainWordDto } from './dto/explain-word.dto';
import type { WordExplanation } from './types/word-explanation';

@Controller('explain-word')
export class ExplainController {
  constructor(
    private readonly explainService: ExplainService,
    private readonly rateLimiter: TranslationRateLimiter,
    private readonly explainCache: ExplainCacheService,
  ) {}

  @Post()
  async explainWord(@Body() body: ExplainWordDto): Promise<WordExplanation> {
    const key = { ...body, provider: this.explainService.providerName };
    // Cache hit và request trùng đang chạy không tiêu quota chung với caption.
    const cached = this.explainCache.lookup(key);
    if (cached) return cached;
    const inflight = this.explainCache.inflight(key);
    if (inflight) {
      try {
        return await inflight;
      } catch (error: unknown) {
        throw this.mapProviderError(error);
      }
    }

    const waitMs = this.rateLimiter.tryAcquire();
    if (waitMs > 0) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message:
            `Explain rate limit reached (${TRANSLATE_MAX_PER_WINDOW} ` +
            `requests per minute). Retry in ${Math.ceil(waitMs / 1000)}s.`,
          retryAfterMs: waitMs,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    try {
      return await this.explainCache.track(key, () =>
        this.explainService.explainWord(body),
      );
    } catch (error: unknown) {
      throw this.mapProviderError(error);
    }
  }

  private mapProviderError(error: unknown): unknown {
    if (error instanceof ProviderUnavailableError) {
      if (!error.retryable) {
        // Quota provider ảnh hưởng cả translate; lỗi retryable chỉ ảnh hưởng request này.
        this.rateLimiter.pauseUntil(Date.now() + error.retryAfterMs);
        return new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: 'Explain provider quota exhausted.',
            retryAfterMs: error.retryAfterMs,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      return new HttpException(
        {
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          message: 'Explain provider temporarily overloaded.',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return error;
  }
}
