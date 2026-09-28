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

/** Base URL gốc — tài liệu: https://commandcode.ai/docs/provider */
const DEFAULT_BASE_URL = 'https://api.commandcode.ai/provider/v1';

/**
 * Model MẶC ĐỊNH — cố ý chọn dòng rẻ, KHÔNG phải dòng đắt.
 *
 * ⚠️ Đổi dòng model là đổi chi phí, nên default phải là dòng "flash" (nhanh +
 * rẻ) chứ không phải dòng "pro"/"max". Parker yêu cầu rõ: dùng model tối ưu
 * chi phí, không dùng model đắt. Việc dịch caption EN→VI là việc ngắn, lặp lại
 * liên tục, ~15–25 nhóm caption/phút — đây đúng là loại việc dòng flash làm
 * được, không cần dòng đắt.
 *
 * Ghi đè bằng env `AI_MODEL` (xem `ai.module.ts`) nếu muốn đổi.
 */
const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';

/**
 * 503 = model quá tải, TẠM THỜI. Thử lại đặt ở TẦNG GATEWAY, không ở đây.
 * ⚠️ Xem `callChat` — provider này KHÔNG tự retry, vì gateway đang đếm quota.
 */
const RETRYABLE_STATUS = new Set([503]);

/**
 * 429 = hết quota. Tài liệu nói upstream trả 429 với `rate_limit_error`.
 *
 * ⚠️ KHÔNG retry ở bất kỳ đâu — xem `ProviderUnavailableError`. Hết quota là
 * trạng thái của CẢ PROJECT trong cửa sổ một phút, thử lại trong cùng phút chỉ
 * tổ đốt thêm quota mà chắc chắn vẫn 429 (Issue 5.12).
 */
const QUOTA_STATUS = 429;

const MAX_RETRY_DELAY_MS = 8_000;

/**
 * Chờ tối thiểu khi provider báo 429 mà KHÔNG kèm gợi ý thời gian.
 *
 * ⚠️ Không có con số này thì 429 rơi về `retryAfterMs = 0` ⇒
 * `pauseUntil(now + 0)` là no-op ⇒ hàng đợi thử lại ngay lập tức ⇒ đốt quota
 * liên tục. Đó đúng là cái bão request đã xảy ra ở Issue 5.12. Quota của hệ
 * thống này tính theo CỬA SỔ MỘT PHÚT (`TRANSLATE_WINDOW_MS`), nên phải chờ
 * hết cửa sổ là lựa chọn thận trọng đúng bản chất quota.
 */
const QUOTA_FALLBACK_DELAY_MS = 60_000;

/**
 * Backoff gợi ý cho 503 — lỗi của chính batch này, không phải quota.
 *
 * ⚠️ CHỈ LÀ GỢI Ý đặt vào `ProviderUnavailableError.retryAfterMs` cho tầng
 * gateway. Việc thử lại thật do gateway làm, vì chỉ nó đếm được số request
 * trong cửa sổ quota.
 *
 * ⚠️ Cố ý KHÔNG import từ `gemini.provider` dù logic giống hệt: mỗi provider
 * một file độc lập, đổi transport của Gemini không được kéo theo file này.
 */
export function retryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
}

/**
 * Thời gian server dặn chờ sau 429, đọc từ body rồi tới header.
 *
 * ⚠️ KHÔNG cap giá trị này (khác hẳn backoff của 503). Quota là per MINUTE, nên
 * cắt nó xuống dưới một phút là tự bảo đảm lần thử kế tiếp rơi đúng vào cửa sổ
 * vừa cạn, rồi 429 lại, và cứ thế.
 *
 * Thứ tự nguồn: body (`retryDelay`/`retry_after`) → header `Retry-After` →
 * `QUOTA_FALLBACK_DELAY_MS`. Tài liệu của CommandCode không nêu tên field
 * `retryDelay` (đó là tên Gemini trả về), nên phải đọc cả hai và có đường lùi
 * an toàn — xem `QUOTA_FALLBACK_DELAY_MS`.
 */
export function serverRetryDelayMs(body: string, headers?: Headers): number {
  // 1. Body: {"retryDelay":"31s"} (kiểu Gemini) hoặc {"retry_after": 31}
  const delayField =
    /"(?:retryDelay|retry_after|retryDelayMs)"\s*:\s*"?(\d+(?:\.\d+)?)"?/.exec(
      body,
    );
  if (delayField) return Number(delayField[1]) * 1000;

  // 2. Header chuẩn HTTP: số giây, hoặc ngày HTTP tuyệt đối.
  const header = headers?.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return seconds * 1000;

    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }

  // 3. Không có gợi ý nào ⇒ chờ hết cửa sổ quota một phút.
  return QUOTA_FALLBACK_DELAY_MS;
}

/** Envelope phẳng cho 1 câu. */
interface TranslateResult {
  translation: string;
}

/** Envelope cho batch: mỗi phần tử tự mang số thứ tự câu của nó. */
interface TranslateBatchResult {
  translations: Array<{ index: number; translation: string }>;
}

/** Envelope cho explain. */
interface ExplainResult {
  meaning: string;
  translation: string;
  example: string;
  pronunciation: string | null;
}

/**
 * Bóc JSON ra khỏi câu trả lời của model.
 *
 * ⚠️ Chat Completions KHÔNG có `responseSchema` như Gemini, nên không thể ép
 * model trả JSON đúng kiểu cấu trúc. Chỉ còn cách dặn trong prompt rồi tự bóc.
 * Model hay bọc JSON trong ```json ... ``` hoặc kèm một câu giải thích trước/
 * sau, nên phải cắt phần rác trước khi `JSON.parse`.
 *
 * ⚠️ KHÔNG gửi `response_format: {type:'json_object'}`: tài liệu CommandCode
 * không liệt kê field đó cho `/chat/completions`, gửi field lạ dễ nhận 400 —
 * hậu quả là mất bản dịch, tệ hơn nhiều so với phải tự bóc JSON.
 */
export function extractJson(raw: string): string {
  let text = raw.trim();

  // Bỏ fence ```json ... ``` nếu có.
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fence) text = fence[1].trim();

  // Cắt tới `{` đầu và `}` cuối cùng để loa phần rác model thêm vào.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Model returned no JSON object');
  }
  return text.slice(start, end + 1);
}

/**
 * Provider đi qua CommandCode — OpenAI Chat Completions.
 *
 * Tài liệu: https://commandcode.ai/docs/provider
 * - Base URL: `https://api.commandcode.ai/provider/v1`
 * - Endpoint: `POST /chat/completions`
 * - Auth: `Authorization: Bearer <CMD_API_KEY>`
 *
 * ⚠️ Key nằm ở backend `.env`, TUYỆT ĐỐI không đóng gói vào extension (xem
 * CLAUDE.md). Provider này chỉ được dựng phía server.
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
   * POST MỘT chat completion và trả JSON đã parse.
   *
   * ⚠️ Hàm này KHÔNG tự thử lại, và đó là chủ ý — đừng thêm retry vào đây.
   *
   * Lý do: throttle của gateway đếm số request để giữ trần. Retry nội bộ ở đây
   * khiến MỘT lượt drain bắn nhiều HTTP call mà bộ đếm không thấy gì cả — đã
   * đo được 26 request/phút so với trần 15 (Issue 5.12).
   *
   * Nên cả 429 lẫu 503 đều ném `ProviderUnavailableError` lên gateway, kèm cờ
   * `retryable` để gateway biết phải tính công (503 — lỗi của chính batch) hay
   * re-queue không tính công (429 — quota của cả project).
   */
  private async callChat<T>(prompt: string): Promise<T> {
    const url = `${this.baseUrl}/chat/completions`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Key nằm trong HEADER, không nằm trong URL như Gemini ⇒ log lỗi không
        // bao giờ rò rỉ key ra (Gemini phải `throw` thay vì log body).
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        // Nhiệt độ 0: dịch thuật cần TÍNH LẶP LẠI, không cần sáng tạo.
        temperature: 0,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      const status = res.status;

      // 429: quota của cả project trong một phút — KHÔNG thử lại ở bất kỳ đâu.
      // Ném lên để gateway tạm dừng MỌI request, giữ nguyên thời gian server dặn.
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

      // 503: model quá tải — tạm thời và thuộc về chính batch này. Gateway sẽ thử
      // lại, nhưng TÍNH CÔNG để một đợt quá tải dài không giữ câu vô hạn.
      if (RETRYABLE_STATUS.has(status)) {
        this.logger.warn(`HTTP ${status} (overloaded), deferring retry`);
        throw new ProviderUnavailableError(
          `Request failed (HTTP ${status})`,
          retryDelayMs(1),
          true,
        );
      }

      // Còn lại (401 sai key, 403 upgrade_required, 400, 500) — lỗi của CHÍNH
      // batch. Gateway tính công rồi bỏ sau MAX lần. Key nằm trong header nên
      // log body ở đây không lộ bí mật.
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
   * Dịch nhiều câu trong 1 request (design §4.3 "batched on finalize").
   *
   * Mảng trả về SONG SANG với mảng vào: `result[i].text` là bản dịch của
   * `sentences[i]`. Nếu model trả thiếu/thừa phần tử thì ném lỗi — im lặng ghép
   * lệch index sẽ gán bản dịch của câu này cho câu khác, tệ hơn là không dịch gì.
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

    // Model hay trả chuỗi "null" hoặc rỗng thay vì JSON null — gộp về null để
    // side panel không hiện từ khoá rỗng.
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
