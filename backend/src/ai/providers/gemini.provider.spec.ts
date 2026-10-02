import { GeminiProvider, retryDelayMs, serverRetryDelayMs } from './gemini.provider';
import { ProviderUnavailableError } from '../errors';

describe('GeminiProvider', () => {
  // Provider config
  let provider: GeminiProvider;
  beforeEach(() => {
    provider = new GeminiProvider({
      apiKey: 'test-key',
      model: 'gemini-test',
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    // Prevent mock fetch from leaking across tests
  });
  it('constructor throws when apiKey missing', () => {
    expect(() => new GeminiProvider({ apiKey: '' })).toThrow(
      'apiKey is required',
    );
  });

  it('translate calls generateContent and returns mapped Translation', async () => {
    // mock global fetch resolved value
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: '{"translation":"Xin chào"}' }],
            },
          },
        ],
      }),
    });
    // call provider.translate()
    const result = await provider.translate('Hello', 'vi', 'en');
    // assert
    expect(result).toEqual({
      text: 'Xin chào',
      from: 'en',
      to: 'vi',
    });
  });
  it('explainWord maps fields and defaults pronunciation to null', async () => {
    // mock fetch result
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: '{"meaning":"Hello","translation":"Xin chào","example":"Hello, how are you?"}',
                },
              ],
            },
          },
        ],
      }),
    });
    // call provider.explainWord
    const result = await provider.explainWord(
      'Hello',
      'Hello, how are you?',
      'vi',
    );
    // assert
    expect(result).toEqual({
      word: 'Hello',
      meaning: 'Hello',
      translation: 'Xin chào',
      example: 'Hello, how are you?',
      pronunciation: null,
    });
  });
  it('does not retry a 500', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'boom',
    });

    await expect(provider.translate('Hello', 'vi', 'en')).rejects.toThrow(
      'Request failed (HTTP 500)',
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('throws HTTP error when fetch !ok', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'boom',
    });
    // call translate
    await expect(provider.translate('Hello', 'vi', 'en')).rejects.toThrow(
      'Request failed (HTTP 500)',
    );
    // call explainWord
    await expect(
      provider.explainWord('Hello', 'Hello, how are you?', 'vi'),
    ).rejects.toThrow('Request failed (HTTP 500)');
  });

  it('does NOT retry a 503 internally — defers the retry to the gateway', async () => {
    // Đây là điều kiện để throttle của gateway đo ĐÚNG số request. Retry nội
    // bộ ở đây sẽ khiến một lượt drain bắn nhiều HTTP call mà throttle không
    // thấy (probe từng đo 26 request/phút so với trần 15).
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => '{"error":{"status":"UNAVAILABLE"}}',
    });

    await expect(provider.translate('Hello', 'vi', 'en')).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    // Đúng MỘT lần gọi: không thử lại bên trong.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('marks a 503 as retryable but a 429 as not', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => '{"error":{"status":"UNAVAILABLE"}}',
    });
    await expect(provider.translate('Hello', 'vi', 'en')).rejects.toMatchObject({
      retryable: true,
    });

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => '{"error":{"details":[{"retryDelay":"22s"}]}}',
    });
    await expect(provider.translate('Hello', 'vi', 'en')).rejects.toMatchObject({
      retryable: false,
      retryAfterMs: 22_000,
    });
  });

  describe('translateBatch', () => {
    it('sends one request for many sentences and maps them back in order', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: '{"translations":[{"index":1,"translation":"A"},{"index":2,"translation":"B"}]}',
                  },
                ],
              },
            },
          ],
        }),
      });

      const result = await provider.translateBatch(['one', 'two'], 'vi', 'en');

      expect(result.map((r) => r.text)).toEqual(['A', 'B']);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('rejects rather than mismatching when a sentence is missing', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  { text: '{"translations":[{"index":1,"translation":"A"}]}' },
                ],
              },
            },
          ],
        }),
      });

      await expect(
        provider.translateBatch(['one', 'two'], 'vi', 'en'),
      ).rejects.toThrow('missing sentence 2 of 2');
    });

    it('makes no request for an empty batch', async () => {
      global.fetch = jest.fn();
      expect(await provider.translateBatch([], 'vi', 'en')).toEqual([]);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('retryDelayMs (503 backoff)', () => {
    it('backs off exponentially', () => {
      expect(retryDelayMs(1)).toBe(1000);
      expect(retryDelayMs(2)).toBe(2000);
    });

    it('caps the wait so one bad request cannot stall the stream', () => {
      expect(retryDelayMs(10)).toBe(8000);
    });
  });

  describe('serverRetryDelayMs (429 quota)', () => {
    it('reads the delay the server asked for', () => {
      expect(serverRetryDelayMs('{"retryDelay":"22.7s"}')).toBe(22700);
    });

    it('does NOT cap it — quota is per minute, so a short wait is wasted', () => {
      expect(serverRetryDelayMs('{"retryDelay":"22s"}')).toBe(22000);
    });

    it('falls back to a full quota window when the server gave no delay', () => {
      // 0 ở đây là `pauseUntil(now + 0)` = no-op ⇒ hàng đợi bắn lại ngay và
      // đốt trọn một cửa sổ quota bằng các request chắc chắn 429 (Issue 5.36).
      expect(serverRetryDelayMs('{}')).toBe(60_000);
    });
  });
});
