import { Injectable, Logger } from '@nestjs/common';
import { TranslationProvider } from '../contracts/translation-provider';
import { ExplainProvider } from '../contracts/explain-provider';
import { Translation } from '../types/translation';
import { WordExplanation } from '../types/word-explanation';

export interface GeminiConfig {
  apiKey: string;
  model?: string;
}

/**
 * Trạng thái đáng thử lại: 429 (hết quota tạm thời) và 503 (model quá tải).
 * 500 để nguyên — đó là lỗi phía Gemini, thử lại chỉ tốn thời gian.
 */
const RETRYABLE_STATUS = new Set([429, 503]);
const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 8_000;

/**
 * 429 trả kèm `retryDelay: "5s"` trong body — tôn trọng nó. 503 không có, nên
 * backoff mũ. Luôn lấy giá trị LỚN HƠN để không thử lại sớm hơn server cho phép.
 */
export function retryDelayMs(body: string, attempt: number): number {
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  const fromServer = match ? Number(match[1]) * 1000 : 0;
  const backoff = 1000 * 2 ** (attempt - 1);
  return Math.min(Math.max(fromServer, backoff), MAX_RETRY_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
   * POST one generateContent call asking for structured JSON.
   *
   * 429 (hết quota phút) và 503 (model quá tải) là trạng thái TẠM THỜI của
   * Gemini — thử lại thay vì bỏ luôn câu đó. Không có queue nên vẫn có thể
   * vượt trần RPM khi caption về dồn dập; retry chỉ giảm số câu mất trắng.
   */
  private async callGemini<T>(prompt: string, schema: object): Promise<T> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    for (let attempt = 1; ; attempt++) {
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
      // 429/503 là tạm thời; 500 để nguyên — thử lại chỉ tốn thời gian.
      if (RETRYABLE_STATUS.has(status) && attempt < MAX_ATTEMPTS) {
        const delay = retryDelayMs(text, attempt);
        this.logger.warn(
          `HTTP ${status}, retry ${attempt}/${MAX_ATTEMPTS - 1} in ${delay}ms`,
        );
        await sleep(delay);
        continue;
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
