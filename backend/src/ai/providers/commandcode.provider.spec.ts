import {
  CommandCodeProvider,
  extractJson,
  retryDelayMs,
  serverRetryDelayMs,
} from './commandcode.provider';
import { ProviderUnavailableError } from '../errors';

/** Builds a fake OpenAI Chat Completions response. */
function chatResponse(content: string) {
  return {
    ok: true,
    headers: new Headers(),
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

/** Fake error response: no `json`, only `ok`/`status`/`text`/`headers`. */
function errorResponse(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    ok: false,
    status,
    headers: new Headers(headers),
    text: async () => body,
  };
}

describe('CommandCodeProvider', () => {
  let provider: CommandCodeProvider;
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
    provider = new CommandCodeProvider({
      apiKey: 'test-key',
      model: 'test-model',
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('constructor throws when apiKey missing', () => {
    expect(() => new CommandCodeProvider({ apiKey: '' })).toThrow(
      'apiKey is required',
    );
  });

  it('sends the key as a Bearer header and never in the URL', async () => {
    fetchMock.mockResolvedValue(chatResponse('{"translation":"Xin chào"}'));

    await provider.translate('Hello', 'vi', 'en');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.commandcode.ai/provider/v1/chat/completions');
    expect(url).not.toContain('test-key');
    // The key must live in the header: Gemini puts it in the URL, so a logged
    // error body would leak it. Here the body is logged, so the key must not be in the URL.
    expect(init.headers.Authorization).toBe('Bearer test-key');
  });

  it('defaults to the cheap flash model and honours an override', async () => {
    fetchMock.mockResolvedValue(chatResponse('{"translation":"Xin chào"}'));

    const cheap = new CommandCodeProvider({ apiKey: 'k' });
    await cheap.translate('Hello', 'vi', 'en');
    // Default must stay on the cheap tier — an expensive model here is a cost hazard.
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe(
      'deepseek/deepseek-v4-flash',
    );

    const overridden = new CommandCodeProvider({ apiKey: 'k', model: 'other/cheap' });
    await overridden.translate('Hello', 'vi', 'en');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).model).toBe('other/cheap');
  });

  it('translate maps the envelope to a Translation', async () => {
    fetchMock.mockResolvedValue(chatResponse('{"translation":"Xin chào"}'));

    await expect(provider.translate('Hello', 'vi', 'en')).resolves.toEqual({
      text: 'Xin chào',
      from: 'en',
      to: 'vi',
    });
  });

  it('sends stream:false so the response is one JSON body', async () => {
    fetchMock.mockResolvedValue(chatResponse('{"translation":"Xin chào"}'));

    await provider.translate('Hello', 'vi', 'en');

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).stream).toBe(false);
  });

  it('unwraps JSON out of a fenced code block', async () => {
    fetchMock.mockResolvedValue(
      chatResponse('```json\n{"translation":"Xin chào"}\n```'),
    );

    await expect(provider.translate('Hello', 'vi', 'en')).resolves.toMatchObject({
      text: 'Xin chào',
    });
  });

  it('throws when the model returns prose with no JSON object', async () => {
    fetchMock.mockResolvedValue(chatResponse('Xin chào'));

    await expect(provider.translate('Hello', 'vi', 'en')).rejects.toThrow(
      'Model returned no JSON object',
    );
  });

  describe('translateBatch', () => {
    it('returns one translation per sentence, in order', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(
          '{"translations":[{"index":1,"translation":"A"},{"index":2,"translation":"B"}]}',
        ),
      );

      const result = await provider.translateBatch(
        ['One', 'Two'],
        'vi',
        'en',
      );

      expect(result).toEqual([
        { text: 'A', from: 'en', to: 'vi' },
        { text: 'B', from: 'en', to: 'vi' },
      ]);
    });

    it('sends all sentences in ONE request', async () => {
      fetchMock.mockResolvedValue(
        chatResponse('{"translations":[{"index":1,"translation":"A"}]}'),
      );

      await provider.translateBatch(['One'], 'vi', 'en');

      // One sentence still goes through one request — batching cuts the REQUEST
      // COUNT, not the sentence size.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('throws rather than silently shifting indexes on a missing sentence', async () => {
      fetchMock.mockResolvedValue(
        chatResponse('{"translations":[{"index":1,"translation":"A"}]}'),
      );

      // The model omitted sentence 2; silently shifting indexes would assign "A"
      // to both — far worse than translating nothing.
      await expect(
        provider.translateBatch(['One', 'Two'], 'vi', 'en'),
      ).rejects.toThrow('Batch translation missing sentence 2 of 2');
    });

    it('returns [] for an empty batch without calling the API', async () => {
      await expect(provider.translateBatch([], 'vi', 'en')).resolves.toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('explainWord', () => {
    it('maps fields and nulls an empty pronunciation', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(
          '{"meaning":"Xin chào","translation":"Chào","example":"Xin chào bạn","pronunciation":null}',
        ),
      );

      await expect(
        provider.explainWord('Hello', 'Hello, how are you?', 'vi'),
      ).resolves.toEqual({
        word: 'Hello',
        meaning: 'Xin chào',
        translation: 'Chào',
        example: 'Xin chào bạn',
        pronunciation: null,
      });
    });

    it('treats the string "null" as no pronunciation', async () => {
      fetchMock.mockResolvedValue(
        chatResponse(
          '{"meaning":"M","translation":"C","example":"E","pronunciation":"null"}',
        ),
      );

      const result = await provider.explainWord('w', 'c', 'vi');

      expect(result.pronunciation).toBeNull();
    });
  });

  describe('error mapping', () => {
    it('maps 429 to a NON-retryable error so the project-wide quota pause fires', async () => {
      fetchMock.mockResolvedValue(
        errorResponse(429, '{"error":{"type":"rate_limit_error"}}'),
      );

      const error = await provider
        .translate('Hello', 'vi', 'en')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProviderUnavailableError);
      expect((error as ProviderUnavailableError).retryable).toBe(false);
    });

    it('maps 503 to a RETRYABLE error that counts against this batch only', async () => {
      fetchMock.mockResolvedValue(errorResponse(503, 'overloaded'));

      const error = await provider
        .translate('Hello', 'vi', 'en')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProviderUnavailableError);
      expect((error as ProviderUnavailableError).retryable).toBe(true);
    });

    it('treats 401 as a plain error, not a retryable one', async () => {
      fetchMock.mockResolvedValue(errorResponse(401, '{"error":"bad key"}'));

      const error = await provider
        .translate('Hello', 'vi', 'en')
        .catch((e: unknown) => e);

      expect(error).not.toBeInstanceOf(ProviderUnavailableError);
    });

    it('does NOT retry on its own', async () => {
      fetchMock.mockResolvedValue(errorResponse(503, 'overloaded'));

      await provider.translate('Hello', 'vi', 'en').catch(() => undefined);

      // In-provider retry makes one drain fire several HTTP calls the gateway's
      // quota counter never sees (Issue 5.12); retrying belongs to the gateway.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe('serverRetryDelayMs', () => {
  it('reads a retryDelay field from the body', () => {
    expect(serverRetryDelayMs('{"retryDelay":"31s"}')).toBe(31_000);
  });

  it('reads a numeric retry_after from the body', () => {
    expect(serverRetryDelayMs('{"retry_after": 12}')).toBe(12_000);
  });

  it('falls back to the Retry-After header', () => {
    const headers = new Headers({ 'retry-after': '20' });
    expect(serverRetryDelayMs('{}', headers)).toBe(20_000);
  });

  it('falls back to a full quota WINDOW when the body says nothing', () => {
    // Without this branch retryAfterMs = 0 ⇒ `pauseUntil(now + 0)` is a no-op
    // ⇒ the queue retries at once ⇒ quota burns continuously (Issue 5.12).
    expect(serverRetryDelayMs('{"error":"rate_limit_error"}')).toBe(60_000);
  });

  it('does NOT cap a short server hint below the quota window', () => {
    // Quota is per MINUTE: clamping to 2s guarantees the next attempt lands in
    // the just-drained window, 429s again, and so on.
    expect(serverRetryDelayMs('{"retryDelay":"2s"}')).toBe(2_000);
  });
});

describe('retryDelayMs', () => {
  it('backs off exponentially and caps', () => {
    expect(retryDelayMs(1)).toBe(1_000);
    expect(retryDelayMs(2)).toBe(2_000);
    expect(retryDelayMs(10)).toBe(8_000);
  });
});

describe('extractJson', () => {
  it('returns a bare object untouched', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it('strips a json fence', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('cuts surrounding prose the model added', () => {
    expect(extractJson('Sure! {"a":1} Hope that helps.')).toBe('{"a":1}');
  });

  it('throws when there is no object at all', () => {
    expect(() => extractJson('no json here')).toThrow(
      'Model returned no JSON object',
    );
  });
});
