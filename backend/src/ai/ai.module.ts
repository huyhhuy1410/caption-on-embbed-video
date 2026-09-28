import { Logger, Module } from '@nestjs/common';
import { CommandCodeProvider } from './providers/commandcode.provider';
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

/** Tên provider hợp lệ — xem `createAiProvider`. */
const PROVIDER_NAMES = ['commandcode', 'gemini'] as const;
type ProviderName = (typeof PROVIDER_NAMES)[number];

/**
 * Chọn provider AI theo môi trường.
 *
 * Provider MẶC ĐỊNH là `commandcode` (Parker chọn 2026-09-28). `gemini` vẫn
 * còn nguyên để quay lui: đổi `AI_PROVIDER=gemini` là chạy lại đúng đường cũ.
 *
 * ⚠️ Phải fallback chứ không để provider ném lỗi ở đây: constructor của chúng
 * `throw` khi thiếu key, và factory này chạy lúc Nest khởi động ⇒ thiếu key là
 * app không boot, kéo theo cả caption EN (vốn không cần AI) chết theo.
 *
 * ⚠️ Tên provider lạ KHÔNG được `throw` ở đây — cùng lý do: app sẽ không boot.
 * Ghi log cảnh báo rồi rơi về mặc định để caption vẫn chạy.
 */
function createAiProvider(): TranslationProvider & ExplainProvider {
  const apiKey = process.env.AI_API_KEY ?? '';
  if (!apiKey) {
    return new NullProvider();
  }

  const requested = process.env.AI_PROVIDER;
  let name: ProviderName = 'commandcode';
  if (requested) {
    if ((PROVIDER_NAMES as readonly string[]).includes(requested)) {
      name = requested as ProviderName;
    } else {
      new Logger('AiModule').warn(
        `Unknown AI_PROVIDER "${requested}" — falling back to "${name}".`,
      );
    }
  }

  if (name === 'gemini') {
    return new GeminiProvider({
      apiKey,
      model: process.env.AI_MODEL ?? undefined,
    });
  }

  return new CommandCodeProvider({
    apiKey,
    // `AI_MODEL` ghi đè được dòng flash mặc định — xem `DEFAULT_MODEL`.
    model: process.env.AI_MODEL ?? undefined,
    baseUrl: process.env.AI_BASE_URL ?? undefined,
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
