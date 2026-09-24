import { Module } from '@nestjs/common';
import { GeminiProvider } from './providers/gemini.provider';
import { NullProvider } from './providers/null.provider';
import { EXPLAIN_PROVIDER, TRANSLATION_PROVIDER } from './tokens';
import { TranslateService } from './translate.service';
import { ExplainService } from './explain.service';
import { TranslationRateLimiter } from './translation-rate-limiter.service';
import { TranslateController } from './translate.controller';
import { ExplainController } from './explain.controller';
import type { TranslationProvider } from './contracts/translation-provider';
import type { ExplainProvider } from './contracts/explain-provider';

/**
 * Chọn provider AI theo môi trường.
 *
 * ⚠️ Phải fallback chứ không để `GeminiProvider` ném lỗi ở đây: constructor của
 * nó `throw` khi thiếu key, và factory này chạy lúc Nest khởi động ⇒ thiếu key
 * là app không boot, kéo theo cả caption EN (vốn không cần AI) chết theo.
 */
function createAiProvider(): TranslationProvider & ExplainProvider {
  const apiKey = process.env.AI_API_KEY ?? '';
  if (!apiKey) {
    return new NullProvider();
  }
  return new GeminiProvider({
    apiKey,
    model: process.env.AI_MODEL ?? undefined,
  });
}

@Module({
  providers: [
    TranslateService,
    ExplainService,
    // Bo dem quota dung chung cho ca duong WS (gateway) lan duong HTTP.
    TranslationRateLimiter,
    {
      // Một instance duy nhất chia cho cả hai token bên dưới.
      provide: 'AI_PROVIDER',
      useFactory: createAiProvider,
    },
    {
      provide: TRANSLATION_PROVIDER,
      useExisting: 'AI_PROVIDER',
    },
    {
      provide: EXPLAIN_PROVIDER,
      useExisting: 'AI_PROVIDER',
    },
  ],
  exports: [
    TRANSLATION_PROVIDER,
    EXPLAIN_PROVIDER,
    TranslateService,
    ExplainService,
    TranslationRateLimiter,
  ],
  controllers: [TranslateController, ExplainController],
})
export class AiModule {}
