import { Translation } from '../types/translation';

export interface TranslationProvider {
  readonly name: string;
  translate(sentence: string, to: string, from: string): Promise<Translation>;

  /**
   * Translate multiple sentences in one request. Returns array parallel to input
   * (`result[i]` is translation of `sentences[i]`). Batching keeps us under the
   * 15 RPM free-tier limit (design §4.3).
   */
  translateBatch(
    sentences: string[],
    to: string,
    from: string,
  ): Promise<Translation[]>;
}
