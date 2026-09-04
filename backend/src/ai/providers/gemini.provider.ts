import { Injectable, Logger } from '@nestjs/common';
import { TranslationProvider } from '../contracts/translation-provider';
import { ExplainProvider } from '../contracts/explain-provider';
import { Translation } from '../types/translation';
import { WordExplanation } from '../types/word-explanation';

export interface GeminiConfig {
  apiKey: string;
  model?: string;
}

/** Stable JSON envelope Gemini returns for translate (via responseSchema). */
interface GeminiTranslateResult {
  translation: string;
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

  /** POST one generateContent call asking for structured JSON. Returns parsed + validated body. */
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
      // Parse Gemini error body without leaking the key (key is in URL, not echoed).
      const text = await res.text();
      this.logger.error(`HTTP ${res.status}: ${text}`);
      throw new Error(`Request failed (HTTP ${res.status})`);
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
