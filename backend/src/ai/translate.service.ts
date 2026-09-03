import { Inject, Injectable } from '@nestjs/common';
import { TRANSLATION_PROVIDER } from './tokens';
import type { TranslationProvider } from './contracts/translation-provider';
import { Translation } from './types/translation';
export interface TranslateInput {
  sentence: string;
  from: string;
  to: string;
}
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
}
