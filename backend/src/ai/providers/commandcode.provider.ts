import { Injectable, Logger } from '@nestjs/common';
import { TranslationProvider } from '../contracts/translation-provider';
import { ExplainProvider } from '../contracts/explain-provider';
import { Translation } from '../types/translation';
import { WordExplanation } from '../types/word-explanation';
import { ProviderUnavailableError } from '../errors';

export interface CommandCodeConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

/** Base URL — docs: https://commandcode.ai/docs/provider */
const DEFAULT_BASE_URL = 'https://api.commandcode.ai/provider/v1';

/**
 * Cheap flash tier, not pro/max: caption translation is high-frequency (~15-25
 * groups/min) short-text work. Override via `AI_MODEL`.
 */
const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';

/**
 * 503 = temporary overload. Retry at GATEWAY layer, not here — gateway tracks quota.
 */
const RETRYABLE_STATUS = new Set([503]);

/** 429 = quota exhausted. Never retry — project-wide state for one minute window. */
const QUOTA_STATUS = 429;

const MAX_RETRY_DELAY_MS = 8_000;

/**
 * Minimum wait when 429 has no retry hint. Without this, `retryAfterMs = 0` makes
 * `pauseUntil()` a no-op → immediate retry burns the exhausted window.
 */
const QUOTA_FALLBACK_DELAY_MS = 60_000;

/**
 * Suggested backoff for 503 (batch-specific, not quota) — a hint for
 * `ProviderUnavailableError.retryAfterMs` only; actual retry happens at gateway.
 * Duplicated in gemini.provider so the two providers stay independent.
 */
export function retryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
}

/**
 * Server-specified wait after 429, from body then header. Never cap this (unlike
 * 503 backoff) — quota is per MINUTE, so capping below 60s guarantees next retry
 * hits the same exhausted window.
 */
export function serverRetryDelayMs(body: string, headers?: Headers): number {
  // Body: {"retryDelay":"31s"} (Gemini-style) or {"retry_after": 31}
  const delayField =
    /"(?:retryDelay|retry_after|retryDelayMs)"\s*:\s*"?(\d+(?:\.\d+)?)"?/.exec(
      body,
    );
  if (delayField) return Number(delayField[1]) * 1000;

  const header = headers?.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return seconds * 1000;

    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }

  return QUOTA_FALLBACK_DELAY_MS;
}

/** Single sentence translation envelope. */
interface TranslateResult {
  translation: string;
}

/** Batch envelope — each item carries its own sentence index. */
interface TranslateBatchResult {
  translations: Array<{ index: number; translation: string }>;
}

/** Word explanation envelope. */
interface ExplainResult {
  meaning: string;
  translation: string;
  example: string;
  pronunciation: string | null;
}

/**
 * Extract JSON from a model response. Chat Completions has no `responseSchema`,
 * so we prompt for JSON and strip fences / surrounding prose before `JSON.parse`.
 */
export function extractJson(raw: string): string {
  let text = raw.trim();

  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fence) text = fence[1].trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Model returned no JSON object');
  }
  return text.slice(start, end + 1);
}

/**
 * CommandCode provider — OpenAI Chat Completions API.
 * Docs: https://commandcode.ai/docs/provider
 * Key stays in backend `.env`, never bundled into extension (see CLAUDE.md).
 */
@Injectable()
export class CommandCodeProvider
  implements TranslationProvider, ExplainProvider
{
  private readonly logger = new Logger(CommandCodeProvider.name);
  readonly name = 'commandcode';
  private readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: CommandCodeConfig) {
    if (!config.apiKey) {
      throw new Error('apiKey is required');
    }
    this.apiKey = config.apiKey;
    this.model = config.model ?? DEFAULT_MODEL;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  /**
   * One chat completion call, parsed JSON out. No retry here — the gateway owns
   * quota; internal retry caused 26 RPM against a 15 limit (Issue 5.12).
   */
  private async callChat<T>(prompt: string): Promise<T> {
    const url = `${this.baseUrl}/chat/completions`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Key in header (unlike Gemini's URL param) so error logs can't leak it.
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        temperature: 0,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      const status = res.status;

      // Quota: project-wide, keep the server's delay uncapped.
      if (status === QUOTA_STATUS) {
        const retryAfterMs = serverRetryDelayMs(text, res.headers);
        this.logger.warn(
          `HTTP 429 (quota), pausing ${Math.round(retryAfterMs / 1000)}s`,
        );
        throw new ProviderUnavailableError(
          `Request failed (HTTP 429)`,
          retryAfterMs,
          false,
        );
      }

      // Overload: gateway retries, but counts attempts to bound the hold.
      if (RETRYABLE_STATUS.has(status)) {
        this.logger.warn(`HTTP ${status} (overloaded), deferring retry`);
        throw new ProviderUnavailableError(
          `Request failed (HTTP ${status})`,
          retryDelayMs(1),
          true,
        );
      }

      // 401/403/400/500: batch-specific. Key is in the header, so the body is safe to log.
      this.logger.error(`HTTP ${status}: ${text}`);
      throw new Error(`Request failed (HTTP ${status})`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) {
      throw new Error('Returned no text content');
    }
    return JSON.parse(extractJson(raw)) as T;
  }

  async translate(
    sentence: string,
    to: string,
    from: string,
  ): Promise<Translation> {
    const prompt = `Translate the following ${from} sentence to ${to} and return only the translation, nothing else.
Sentence: ${sentence}

Return JSON only, in exactly this shape: {"translation": "..."}`;
    const result = await this.callChat<TranslateResult>(prompt);
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

${numbered}

Return JSON only, in exactly this shape:
{"translations": [{"index": 1, "translation": "..."}]}`;

    const result = await this.callChat<TranslateBatchResult>(prompt);

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
Context: ${context}

Return JSON only, in exactly this shape:
{"meaning": "...", "translation": "...", "example": "...", "pronunciation": null}`;

    const result = await this.callChat<ExplainResult>(prompt);

    // Normalize "null" string or empty to actual null
    const pronunciation =
      result.pronunciation?.trim() &&
      result.pronunciation.toLowerCase() !== 'null'
        ? result.pronunciation
        : null;

    return {
      word,
      meaning: result.meaning,
      translation: result.translation,
      example: result.example,
      pronunciation,
    };
  }
}
