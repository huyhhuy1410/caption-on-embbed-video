import { Module } from '@nestjs/common';
import { GeminiProvider } from './providers/gemini.provider';
import { EXPLAIN_PROVIDER, TRANSLATION_PROVIDER } from './tokens';
import { TranslateService } from './translate.service';
import { ExplainService } from './explain.service';
import { TranslateController } from './translate.controller';
import { ExplainController } from './explain.controller';

@Module({
  providers: [
    GeminiProvider,
    {
      provide: TRANSLATION_PROVIDER,
      useClass: GeminiProvider,
    },
    { provide: EXPLAIN_PROVIDER, useClass: GeminiProvider },
    TranslateService,
    ExplainService,
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
