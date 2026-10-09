import {
  HealthService,
  SIDECAR_HEALTH_TIMEOUT_MS,
  SIDECAR_HEALTH_URL,
} from './health.service';

describe('HealthService', () => {
  let fetchMock: jest.SpyInstance;
  const service = new HealthService();
  const response = (body: unknown, ok = true) => ({
    ok,
    json: jest.fn().mockResolvedValue(body),
  });

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchMock.mockRestore();
    jest.useRealTimers();
  });

  it.each(['ready', 'loading', 'error'])(
    'reports %s with model and mode',
    async (status) => {
      fetchMock.mockResolvedValue(
        response({
          status,
          model: 'small',
          mode: 'streaming',
          message: 'model status',
        }),
      );
      expect(await service.check()).toEqual({
        backend: 'ready',
        sidecar: status,
        model: 'small',
        mode: 'streaming',
        message: 'model status',
      });
      expect(fetchMock).toHaveBeenCalledWith(SIDECAR_HEALTH_URL, {
        signal: expect.any(AbortSignal),
        redirect: 'error',
      });
    },
  );

  it.each(['loading', 'error'])(
    'preserves %s returned with HTTP 503',
    async (status) => {
      fetchMock.mockResolvedValue(response({ status }, false));
      expect(await service.check()).toEqual({
        backend: 'ready',
        sidecar: status,
      });
    },
  );

  it('supports legacy status ok', async () => {
    fetchMock.mockResolvedValue(response({ status: 'ok' }));
    expect(await service.check()).toEqual({
      backend: 'ready',
      sidecar: 'ready',
    });
  });

  it('does not report backend down on a sidecar connection failure', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await service.check()).toMatchObject({
      backend: 'ready',
      sidecar: 'unavailable',
    });
  });

  it.each([null, [], 'ready', { status: 'unknown' }])(
    'rejects malformed health body %j',
    async (body) => {
      fetchMock.mockResolvedValue(response(body));
      expect(await service.check()).toMatchObject({
        backend: 'ready',
        sidecar: 'error',
      });
    },
  );

  it('ignores invalid optional field types and bounds displayed strings', async () => {
    fetchMock.mockResolvedValue(
      response({
        status: 'ready',
        model: 'x'.repeat(200),
        mode: 'invalid',
        message: 'y'.repeat(600),
      }),
    );
    const health = await service.check();
    expect(health.model).toHaveLength(100);
    expect(health.message).toHaveLength(500);
    expect(health.mode).toBeUndefined();
  });

  it('does not accept a ready status on an HTTP failure', async () => {
    fetchMock.mockResolvedValue(response({ status: 'ready' }, false));
    expect(await service.check()).toMatchObject({ sidecar: 'unavailable' });
  });

  it('reports invalid JSON as an error, not model loading', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: jest.fn().mockRejectedValue(new SyntaxError('bad JSON')),
    });
    expect(await service.check()).toMatchObject({ sidecar: 'error' });
  });

  it('aborts a stalled fetch at the deadline and clears the timer', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(
      (_url, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => reject(new Error('abort')),
            { once: true },
          );
        }),
    );
    const result = service.check();
    await jest.advanceTimersByTimeAsync(SIDECAR_HEALTH_TIMEOUT_MS);
    expect(await result).toMatchObject({
      backend: 'ready',
      sidecar: 'unavailable',
      message: 'Sidecar health check timed out.',
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps the deadline active while reading the response body', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation((_url, options: RequestInit) =>
      Promise.resolve({
        ok: true,
        json: () =>
          new Promise((_resolve, reject) =>
            options.signal?.addEventListener(
              'abort',
              () => reject(new Error('abort')),
              { once: true },
            ),
          ),
      }),
    );
    const result = service.check();
    await jest.advanceTimersByTimeAsync(SIDECAR_HEALTH_TIMEOUT_MS);
    expect(await result).toMatchObject({
      sidecar: 'unavailable',
      message: 'Sidecar health check timed out.',
    });
    expect(jest.getTimerCount()).toBe(0);
  });
});
