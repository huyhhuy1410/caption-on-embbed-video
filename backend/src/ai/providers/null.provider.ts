import { Logger } from '@nestjs/common';
import { TranslationProvider } from '../contracts/translation-provider';
import { ExplainProvider } from '../contracts/explain-provider';
import { Translation } from '../types/translation';
import { WordExplanation } from '../types/word-explanation';

/**
 * Fallback provider when `AI_API_KEY` is missing. Allows app to boot and English
 * captions to work (they don't need AI); translation/explain calls reject with
 * clear errors so callers can degrade gracefully.
 */
export class NullProvider implements TranslationProvider, ExplainProvider {
  private readonly logger = new Logger(NullProvider.name);
  readonly name = 'null';

  constructor() {
    this.logger.warn(
      'AI_API_KEY is not set — translation and word explanations are disabled. Captions still work.',
    );
  }

  translate(sentence: string, to: string, from: string): Promise<Translation> {
    return Promise.reject(
      new Error(
        `NullProvider.translate: no AI provider configured (${from}->${to})`,
      ),
    );
  }

  translateBatch(
    sentences: string[],
    to: string,
    from: string,
  ): Promise<Translation[]> {
    return Promise.reject(
      new Error(
        `NullProvider.translateBatch: no AI provider configured (${sentences.length} sentences, ${from}->${to})`,
      ),
    );
  }

  explainWord(
    word: string,
    context: string,
    lang: string,
  ): Promise<WordExplanation> {
    return Promise.reject(
      new Error(`NullProvider.explainWord: no AI provider configured (${word})`),
    );
  }
}
