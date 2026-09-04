import { Module } from '@nestjs/common';
import { GeminiProvider } from './providers/gemini.provider';
import { EXPLAIN_PROVIDER, TRANSLATION_PROVIDER } from './tokens';
import { TranslateService } from './translate.service';
import { ExplainService } from './explain.service';
import { TranslateController } from './translate.controller';
import { ExplainController } from './explain.controller';

@Module({
  providers: [
    TranslateService,
    ExplainService,
    {
      // Class-token factory: Nest resolves GeminiProvider (by its class) to the
      // instance this factory builds — the ONE instance both tokens below share.
      provide: GeminiProvider,
      useFactory: () =>
        new GeminiProvider({
          apiKey: process.env.AI_API_KEY ?? '',
          model: process.env.AI_MODEL ?? undefined,
        }),
    },
    {
      provide: TRANSLATION_PROVIDER,
      useExisting: GeminiProvider,
    },
    {
      provide: EXPLAIN_PROVIDER,
      useExisting: GeminiProvider,
    },
  ],
  exports: [
    TRANSLATION_PROVIDER,
    EXPLAIN_PROVIDER,
    TranslateService,
    ExplainService,
  ],
  controllers: [TranslateController, ExplainController],
})
export class AiModule {}
