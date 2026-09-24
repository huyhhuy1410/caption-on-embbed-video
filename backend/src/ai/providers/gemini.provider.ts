import { Injectable, Logger } from '@nestjs/common';
import { TranslationProvider } from '../contracts/translation-provider';
import { ExplainProvider } from '../contracts/explain-provider';
import { Translation } from '../types/translation';
import { WordExplanation } from '../types/word-explanation';
import { ProviderUnavailableError } from '../errors';

export interface GeminiConfig {
  apiKey: string;
  model?: string;
}

/**
 * 503 (model quá tải) là trạng thái TẠM THỜI. Lần thử lại được đặt ở TẦNG GATEWAY,
 * không phải ở đây — xem `callGemini`.
 *
 * ⚠️ 429 KHÔNG retry ở đâu cả — xem `QUOTA_STATUS`. Hết quota là trạng thái của
 * CẢ PROJECT trong cửa sổ một phút, nên thử lại trong cùng phút chỉ tổ đốt thêm
 * quota mà chắc chắn vẫn 429. Chỉ có bộ đếm cửa sổ 60s ở gateway mới biết lúc nào
 * quota mở lại.
 */
const RETRYABLE_STATUS = new Set([503]);
const QUOTA_STATUS = 429;
const MAX_RETRY_DELAY_MS = 8_000;

/**
 * Backoff gợi ý cho 503. 503 không kèm `retryDelay`, nên dùng backoff mũ và cap
 * lại để một request hỏng không treo luồng quá lâu.
 *
 * ⚠️ Chỉ là GỢI Ý đặt vào `ProviderUnavailableError.retryAfterMs` cho tầng
 * gateway. Việc thử lại thật do gateway làm, vì chỉ nó đếm được số request trong
 * cửa sổ quota.
 */
export function retryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
}

/**
 * Thời gian server dặn chờ, đọc từ `retryDelay` trong body lỗi 429.
 *
 * ⚠️ KHÔNG cap giá trị này (khác hẳn backoff của 503). Quota là per MINUTE, nên
 * cắt nó xuống dưới một phút — bản trước cap ở 8s — là tự bảo đảm lần thử kế
 * tiếp rơi đúng vào cửa sổ vừa cạn, rồi 429 lại, và cứ thế.
 */
export function serverRetryDelayMs(body: string): number {
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  return match ? Number(match[1]) * 1000 : 0;
}

/** Stable JSON envelope Gemini returns for translate (via responseSchema). */
interface GeminiTranslateResult {
  translation: string;
}

/** Envelope cho batch: mỗi phần tử tự mang số thứ tự câu của nó. */
interface GeminiTranslateBatchResult {
  translations: Array<{ index: number; translation: string }>;
}

/** Stable JSON envelope Gemini returns for explain (via responseSchema). */
interface GeminiExplainResult {
  meaning: string;
  translation: string;
  example: string;
  pronunciation: string | null;
}

@Injectable()
export class GeminiProvider implements TranslationProvider, ExplainProvider {
  private readonly logger = new Logger(GeminiProvider.name);
  readonly name = 'gemini';
  private readonly model: string;
  private readonly apiKey: string;

  constructor(config: GeminiConfig) {
    if (!config.apiKey) {
      throw new Error('apiKey is required');
    }
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'gemini-2.5-flash';
  }

  /**
   * POST MỘT generateContent call và trả JSON đã parse.
   *
   * ⚠️ Hàm này KHÔNG tự thử lại, và đó là chủ ý — đừng thêm retry vào đây.
   *
   * Lý do: throttle của gateway đếm số request để giữ trần 15 request/phút của
   * Gemini free tier. Retry nội bộ ở đây khiến MỘT lượt drain bắn nhiều HTTP call
   * mà bộ đếm không thấy gì cả. Probe đo được đúng hệ quả đó: 26 request/phút so
   * với trần 15 (Issue 5.12, vòng 2).
   *
   * Nên cả 429 lẫn 503 đều ném `ProviderUnavailableError` lên gateway, kèm cờ
   * `retryable` để gateway biết phải tính công (503 — lỗi của chính batch) hay
   * re-queue không tính công (429 — quota của cả project):
   * - 429 (`retryable = false`): giữ nguyên `retryDelay` server dặn, không cap.
   * - 503 (`retryable = true`): không có `retryDelay`, dùng backoff mũ có cap.
   */
  private async callGemini<T>(prompt: string, schema: object): Promise<T> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: schema,
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      const status = res.status;

      // 429: quota của cả project trong một phút — KHÔNG thử lại ở bất kỳ đâu.
      // Ném lên để gateway tạm dừng MỌI request, và giữ nguyên thời gian server
      // dặn (cap nó xuống dưới một phút là tự bảo đảm lần thử sau rơi đúng vào
      // cửa sổ vừa cạn).
      if (status === QUOTA_STATUS) {
        const retryAfterMs = serverRetryDelayMs(text);
        this.logger.warn(
          `HTTP 429 (quota), pausing ${Math.round(retryAfterMs / 1000)}s`,
        );
        throw new ProviderUnavailableError(
          `Request failed (HTTP 429)`,
          retryAfterMs,
          false,
        );
      }

      // 503: model quá tải — tạm thời và thuộc về chính batch này. Gateway sẽ
      // thử lại, nhưng TÍNH CÔNG để một đợt quá tải dài không giữ câu vô hạn.
      if (RETRYABLE_STATUS.has(status)) {
        this.logger.warn(`HTTP ${status} (overloaded), deferring retry`);
        throw new ProviderUnavailableError(
          `Request failed (HTTP ${status})`,
          retryDelayMs(1),
          true,
        );
      }

      // Parse Gemini error body without leaking the key (key is in URL, not echoed).
      this.logger.error(`HTTP ${status}: ${text}`);
      throw new Error(`Request failed (HTTP ${status})`);
    }

    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error('Returned no text content');
    }
    return JSON.parse(text) as T;
  }

  // ---- TODO (Parker): implement below, using the helpers above ----

  async translate(
    sentence: string,
    to: string,
    from: string,
  ): Promise<Translation> {
    // 1. Build a prompt: "translate this English sentence to Vietnamese... only JSON"
    const prompt = `Translate the following ${from} sentence to ${to} and return only the translation, nothing else.
    Sentence: ${sentence}`;
    // 2. Call this.callGemini<GeminiTranslateResult>(prompt, { type:'object', ... })
    const result = await this.callGemini<GeminiTranslateResult>(prompt, {
      type: 'object',
      properties: {
        translation: { type: 'string' },
      },
      required: ['translation'],
    });

    // 3. Return { text: result.translation, from, to }
    return { text: result.translation, from, to };
  }

  /**
   * Dịch nhiều câu trong 1 request (design §4.3 "batched on finalize").
   *
   * Mảng trả về SONG SONG với mảng vào: `result[i].text` là bản dịch của
   * `sentences[i]`. Nếu Gemini trả thiếu/ thừa phần tử thì ném lỗi — im lặng
   * ghép lệch index sẽ gán bản dịch của câu này cho câu khác, tệ hơn là không
   * dịch gì.
   */
  async translateBatch(
    sentences: string[],
    to: string,
    from: string,
  ): Promise<Translation[]> {
    if (sentences.length === 0) return [];
    if (sentences.length === 1) {
      const one = await this.translate(sentences[0], to, from);
      return [one];
    }

    // Đánh số từng câu để model không trộn thứ tự và để kiểm tra khớp index.
    const numbered = sentences
      .map((sentence, index) => `${index + 1}. ${sentence}`)
      .join('\n');

    const prompt = `Translate each numbered ${from} sentence below to ${to}.
Return one translation per input sentence, in the same order, keeping the same numbering.
Translate only; do not explain, merge, split, or skip any sentence.

${numbered}`;

    const result = await this.callGemini<GeminiTranslateBatchResult>(prompt, {
      type: 'object',
      properties: {
        translations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              index: { type: 'integer' },
              translation: { type: 'string' },
            },
            required: ['index', 'translation'],
          },
        },
      },
      required: ['translations'],
    });

    const byIndex = new Map<number, string>();
    for (const item of result.translations) {
      byIndex.set(item.index, item.translation);
    }

    return sentences.map((_, i) => {
      const text = byIndex.get(i + 1);
      if (text === undefined) {
        throw new Error(
          `Batch translation missing sentence ${i + 1} of ${sentences.length}`,
        );
      }
      return { text, from, to };
    });
  }

  async explainWord(
    word: string,
    context: string,
    lang: string,
  ): Promise<WordExplanation> {
    const prompt = `Explain the word "${word}" AS USED in this sentence context, in ${lang}. 
    Give: (1) its meaning in this context, 
    (2) a ${lang} translation of the word as used here, 
    (3) one short example sentence using the word the same way, 
    (4) pronunciation if known (else null). 
    Return JSON only.
    Context: ${context}`;

    const result = await this.callGemini<GeminiExplainResult>(prompt, {
      type: 'object',
      properties: {
        meaning: { type: 'string' },
        translation: { type: 'string' },
        example: { type: 'string' },
        pronunciation: { type: 'string', nullable: true },
      },
      required: ['meaning', 'translation', 'example'],
    });
    return {
      word,
      meaning: result.meaning,
      translation: result.translation,
      example: result.example,
      pronunciation: result.pronunciation ?? null,
    };
  }
}
