import { Logger } from '@nestjs/common';
import { TranslationProvider } from '../contracts/translation-provider';
import { ExplainProvider } from '../contracts/explain-provider';
import { Translation } from '../types/translation';
import { WordExplanation } from '../types/word-explanation';

/**
 * Provider rỗng, dùng khi KHÔNG có `AI_API_KEY`.
 *
 * Vì sao cần: `GeminiProvider` ném lỗi khi thiếu key, mà `ai.module.ts` dựng nó
 * trong `useFactory` ⇒ Nest không boot được ⇒ hỏng luôn cả caption EN, dù
 * caption EN hoàn toàn không cần AI. Design nói rõ: "Core captions are
 * free/private via local whisper" — chỉ translation/explain mới cần key.
 *
 * Provider này giữ app chạy; tính năng cần AI sẽ trả lỗi rõ ràng để tầng gọi
 * tự quyết định (ví dụ bỏ qua bản dịch, không làm hỏng caption).
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
