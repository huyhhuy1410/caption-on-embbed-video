import { Inject, Injectable } from '@nestjs/common';
import type { ExplainProvider } from './contracts/explain-provider';
import { EXPLAIN_PROVIDER } from './tokens';
import { WordExplanation } from './types/word-explanation';

export interface ExplainInput {
  word: string;
  context: string;
  lang: string;
}

// Service giải thích từ vựng trong ngữ cảnh: ủy quyền cho ExplainProvider (Gemini).
// ⚠️ KHÔNG chạm TranslationRateLimiter ở đây — quota là việc của TẦNG GỌI
// (ExplainController), đúng như TranslateController giữ việc đó cho translate.
// Ghi ở tầng service là chỗ dễ đếm trùng, xem chú thích trong
// translation-rate-limiter.service.ts.
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
