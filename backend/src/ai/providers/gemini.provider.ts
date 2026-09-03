import { Injectable } from '@nestjs/common';
import { TranslationProvider } from '../contracts/translation-provider';
import { ExplainProvider } from '../contracts/explain-provider';
import { Translation } from '../types/translation';
import { WordExplanation } from '../types/word-explanation';

@Injectable()
export class GeminiProvider implements TranslationProvider, ExplainProvider {
  readonly name: string = 'gemini';

  async translate(
    sentence: string,
    to: string,
    from: string,
  ): Promise<Translation> {
    throw new Error('GeminiProvider.translate: not implemented yet');
  }
  async explainWord(
    word: string,
    context: string,
    lang: string,
  ): Promise<WordExplanation> {
    throw new Error('GeminiProvider.explainWord: not implemented yet');
  }
}
