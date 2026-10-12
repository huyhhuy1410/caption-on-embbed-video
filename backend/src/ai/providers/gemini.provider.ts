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

/** 503 = overload, retried by the gateway. 429 = quota gone for the minute, never retried. */
const RETRYABLE_STATUS = new Set([503]);
const QUOTA_STATUS = 429;
const MAX_RETRY_DELAY_MS = 8_000;

/** Suggested 503 backoff when the server sends no `retryDelay` — a hint for the gateway's retry. */
export function retryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
}

/**
 * Minimum wait when a 429 carries no retry hint. Without it `retryAfterMs = 0` makes
 * `pauseUntil()` a no-op and the retry burns the same exhausted window. Duplicated in
 * commandcode.provider so neither provider depends on the other.
 */
const QUOTA_FALLBACK_DELAY_MS = 60_000;

/**
 * Server-specified 429 wait from the body's `retryDelay`. Never capped (unlike the 503
 * backoff): quota is per MINUTE, so a wait under 60s just hits the same exhausted window.
 */
export function serverRetryDelayMs(body: string): number {
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  return match ? Number(match[1]) * 1000 : QUOTA_FALLBACK_DELAY_MS;
}

/** Stable JSON envelope Gemini returns for translate (via responseSchema). */
interface GeminiTranslateResult {
  translation: string;
}

/** Batch envelope — each item carries its own sentence index. */
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
   * Single generateContent call, returns parsed JSON. Intentionally NO retry here
   * — gateway tracks quota (15 RPM free tier). Internal retry caused 26 RPM vs
   * 15 limit (Issue 5.12). Both 429 and 503 throw `ProviderUnavailableError` with
   * `retryable` flag for gateway to handle.
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

      // 429: project-wide quota, pause all requests. Keep server's retry delay uncapped.
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

      // 503: temporary overload, gateway will retry but count attempts to avoid infinite holds.
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

  async translate(
    sentence: string,
    to: string,
    from: string,
  ): Promise<Translation> {
    const prompt = `Translate the following ${from} sentence to ${to} and return only the translation, nothing else.
Sentence: ${sentence}`;

    const result = await this.callGemini<GeminiTranslateResult>(prompt, {
      type: 'object',
      properties: {
        translation: { type: 'string' },
      },
      required: ['translation'],
    });

    return { text: result.translation, from, to };
  }

  /**
   * Batch translate in one request (design §4.3). Returns array parallel to input.
   * Throws if response count mismatches — silent index mismatch is worse than no translation.
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

    // Number sentences to preserve order and verify index alignment.
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
