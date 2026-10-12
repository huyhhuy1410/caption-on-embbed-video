import { Inject, Injectable } from '@nestjs/common';
import { TRANSLATION_PROVIDER } from './tokens';
import type { TranslationProvider } from './contracts/translation-provider';
import { Translation } from './types/translation';
export interface TranslateInput {
  sentence: string;
  from: string;
  to: string;
}
// Delegates to TranslationProvider via DI.
@Injectable()
export class TranslateService {
  constructor(
    @Inject(TRANSLATION_PROVIDER)
    private readonly translationProvider: TranslationProvider,
  ) {}
  async translate(input: TranslateInput): Promise<Translation> {
    return this.translationProvider.translate(
      input.sentence,
      input.to,
      input.from,
    );
  }

  /** Batch translate — see `TranslationProvider.translateBatch`. */
  async translateBatch(
    sentences: string[],
    to: string,
    from: string,
  ): Promise<Translation[]> {
    return this.translationProvider.translateBatch(sentences, to, from);
  }
}
