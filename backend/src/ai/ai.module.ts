import { Logger, Module } from '@nestjs/common';
import { CommandCodeProvider } from './providers/commandcode.provider';
import { GeminiProvider } from './providers/gemini.provider';
import { NullProvider } from './providers/null.provider';
import { EXPLAIN_PROVIDER, TRANSLATION_PROVIDER } from './tokens';
import { TranslateService } from './translate.service';
import { ExplainService } from './explain.service';
import { ExplainCacheService } from './explain-cache.service';
import { TranslationRateLimiter } from './translation-rate-limiter.service';
import { TranslateController } from './translate.controller';
import { ExplainController } from './explain.controller';
import type { TranslationProvider } from './contracts/translation-provider';
import type { ExplainProvider } from './contracts/explain-provider';

/** Valid provider names — see `createAiProvider`. */
const PROVIDER_NAMES = ['commandcode', 'gemini'] as const;
type ProviderName = (typeof PROVIDER_NAMES)[number];

/**
 * Select AI provider by environment. Default: `commandcode`; `gemini` for fallback.
 * Must fallback (not throw) on missing key or unknown provider — constructors throw,
 * and this factory runs at Nest startup. Throwing would prevent app boot, breaking
 * English captions (which don't need AI).
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
    // `AI_MODEL` overrides default flash tier — see `DEFAULT_MODEL`
    model: process.env.AI_MODEL ?? undefined,
    baseUrl: process.env.AI_BASE_URL ?? undefined,
  });
}

@Module({
  providers: [
    TranslateService,
    ExplainService,
    ExplainCacheService,
    // Shared quota counter for both WS and HTTP paths
    TranslationRateLimiter,
    {
      // Single instance shared by both tokens below
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
    ExplainCacheService,
    TranslationRateLimiter,
  ],
  controllers: [TranslateController, ExplainController],
})
export class AiModule {}
