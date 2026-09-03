import { Inject, Injectable } from '@nestjs/common';
import type { ExplainProvider } from './contracts/explain-provider';
import { EXPLAIN_PROVIDER } from './tokens';
import { WordExplanation } from './types/word-explanation';

export interface ExplainInput {
  word: string;
  context: string;
  lang: string;
}
@Injectable()
export class ExplainService {
  constructor(
    @Inject(EXPLAIN_PROVIDER)
    private readonly explainProvider: ExplainProvider,
  ) {}
  async explainWord(input: ExplainInput): Promise<WordExplanation> {
    return this.explainProvider.explainWord(
      input.word,
      input.context,
      input.lang,
    );
  }
}
