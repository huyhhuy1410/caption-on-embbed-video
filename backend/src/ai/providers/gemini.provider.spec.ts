import { GeminiProvider } from './gemini.provider';

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
});
