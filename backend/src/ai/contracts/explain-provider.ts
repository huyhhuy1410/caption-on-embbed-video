import { WordExplanation } from '../types/word-explanation';

export interface ExplainProvider {
  readonly name: string;
  explainWord(
    word: string,
    context: string,
    lang: string,
  ): Promise<WordExplanation>;
}
