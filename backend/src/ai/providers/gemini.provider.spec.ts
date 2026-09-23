import { GeminiProvider, retryDelayMs } from './gemini.provider';

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

  it('retries a 503 then succeeds', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => '{"error":{"status":"UNAVAILABLE"}}',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [
            { content: { parts: [{ text: '{"translation":"Xin chào"}' }] } },
          ],
        }),
      });

    const result = await provider.translate('Hello', 'vi', 'en');
    expect(result.text).toBe('Xin chào');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('gives up after 3 attempts on a persistent 503', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => '{"error":{"status":"UNAVAILABLE"}}',
    });

    await expect(provider.translate('Hello', 'vi', 'en')).rejects.toThrow(
      'Request failed (HTTP 503)',
    );
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  describe('retryDelayMs', () => {
    it('honours a server retryDelay longer than the backoff', () => {
      expect(retryDelayMs('{"retryDelay":"5s"}', 1)).toBe(5000);
    });

    it('falls back to exponential backoff when the server gives none', () => {
      expect(retryDelayMs('{}', 1)).toBe(1000);
      expect(retryDelayMs('{}', 2)).toBe(2000);
    });

    it('caps the wait so a bad value cannot stall the stream', () => {
      expect(retryDelayMs('{"retryDelay":"600s"}', 1)).toBe(8000);
    });
  });
});
