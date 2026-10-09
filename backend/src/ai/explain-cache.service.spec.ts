import {
  DEFAULT_EXPLAIN_CACHE_MAX_ENTRIES,
  DEFAULT_EXPLAIN_CACHE_TTL_MS,
  ExplainCacheKey,
  ExplainCacheService,
} from './explain-cache.service';
import type { WordExplanation } from './types/word-explanation';

const KEY: ExplainCacheKey = {
  word: 'light',
  context: 'this is a light load',
  lang: 'vi',
  provider: 'test-provider',
};

function explanation(meaning: string): WordExplanation {
  return {
    word: 'light',
    meaning,
    translation: 'nhẹ',
    example: 'a light load',
    pronunciation: null,
  };
}

function resolved(
  cache: ExplainCacheService,
  key: ExplainCacheKey,
  meaning: string,
  storedAt = 0,
): Promise<WordExplanation> {
  return cache.track(key, async () => explanation(meaning), () => storedAt);
}

describe('ExplainCacheService', () => {
  let cache: ExplainCacheService;

  beforeEach(() => {
    delete process.env.EXPLAIN_CACHE_TTL_MS;
    delete process.env.EXPLAIN_CACHE_MAX_ENTRIES;
    cache = new ExplainCacheService();
  });

  afterAll(() => {
    delete process.env.EXPLAIN_CACHE_TTL_MS;
    delete process.env.EXPLAIN_CACHE_MAX_ENTRIES;
  });

  describe('defaults', () => {
    it('documents the TTL and entry cap used when env is unset', () => {
      expect(DEFAULT_EXPLAIN_CACHE_TTL_MS).toBe(30 * 60_000);
      expect(DEFAULT_EXPLAIN_CACHE_MAX_ENTRIES).toBe(500);
    });

    it('takes valid overrides from env', async () => {
      process.env.EXPLAIN_CACHE_MAX_ENTRIES = '1';
      const one = new ExplainCacheService();
      await resolved(one, { ...KEY, word: 'a' }, 'a');
      await resolved(one, { ...KEY, word: 'b' }, 'b');

      expect(one.size()).toBe(1);
      expect(one.lookup({ ...KEY, word: 'a' }, 1)).toBeUndefined();
    });

    it('ignores env values that are not positive numbers', async () => {
      process.env.EXPLAIN_CACHE_TTL_MS = 'not-a-number';
      process.env.EXPLAIN_CACHE_MAX_ENTRIES = '-5';
      const fallback = new ExplainCacheService();

      await resolved(fallback, KEY, 'nhẹ', 0);

      expect(fallback.lookup(KEY, 1)).toBeDefined();
      expect(fallback.lookup(KEY, DEFAULT_EXPLAIN_CACHE_TTL_MS)).toBeUndefined();
    });
  });

  it('falls back when fractional env values round down to zero', async () => {
    process.env.EXPLAIN_CACHE_TTL_MS = '0.5';
    process.env.EXPLAIN_CACHE_MAX_ENTRIES = '0.5';
    const fallback = new ExplainCacheService();
    await resolved(fallback, KEY, 'valid');
    expect(fallback.size()).toBe(1);
    expect(fallback.lookup(KEY, 1)).toBeDefined();
  });

  it('returns oversized responses without retaining them', async () => {
    const large = explanation('x'.repeat(64 * 1024));
    await expect(cache.track(KEY, async () => large)).resolves.toBe(large);
    expect(cache.size()).toBe(0);
    expect(cache.pendingCount()).toBe(0);
  });

  it('keeps aggregate response bytes bounded even below the entry cap', async () => {
    for (let i = 0; i < 100; i++) {
      await resolved(cache, { ...KEY, word: `w${i}` }, 'x'.repeat(60 * 1024));
    }
    expect(cache.size()).toBeLessThan(70);
    expect(cache.lookup({ ...KEY, word: 'w0' }, 1)).toBeUndefined();
    expect(cache.lookup({ ...KEY, word: 'w99' }, 1)).toBeDefined();
  });

  it('coalesces synchronous provider throws and releases the pending slot', async () => {
    const failure = new Error('sync failure');
    const run = jest.fn(() => { throw failure; });
    const first = cache.track(KEY, run);
    const second = cache.track(KEY, run);
    expect(second).toBe(first);
    const results = await Promise.allSettled([first, second]);
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(run).toHaveBeenCalledTimes(1);
    expect(cache.pendingCount()).toBe(0);
    expect(cache.size()).toBe(0);
  });

  describe('cache hits', () => {
    it('returns undefined for a key that was never stored', () => {
      expect(cache.lookup(KEY, 0)).toBeUndefined();
    });

    it('returns the stored value for the same key', async () => {
      await resolved(cache, KEY, 'nhẹ');

      expect(cache.lookup(KEY, 10)).toEqual(explanation('nhẹ'));
    });

    it('treats every part of the key as load-bearing', async () => {
      await resolved(cache, KEY, 'nhẹ');

      expect(cache.lookup({ ...KEY, context: 'turn on the light' }, 1)).toBeUndefined();
      expect(cache.lookup({ ...KEY, word: 'lights' }, 1)).toBeUndefined();
      expect(cache.lookup({ ...KEY, lang: 'en' }, 1)).toBeUndefined();
      expect(cache.lookup({ ...KEY, provider: 'gemini' }, 1)).toBeUndefined();
    });

    it('does not confuse keys whose fields contain the separator', async () => {
      await resolved(cache, { ...KEY, context: 'a|b' }, 'first');
      await resolved(cache, { ...KEY, context: 'a', word: 'b|light' }, 'second');

      expect(cache.lookup({ ...KEY, context: 'a|b' }, 1)?.meaning).toBe('first');
      expect(
        cache.lookup({ ...KEY, context: 'a', word: 'b|light' }, 1)?.meaning,
      ).toBe('second');
    });
  });

  describe('TTL expiry', () => {
    it('keeps an entry right up to the TTL and drops it after', async () => {
      await resolved(cache, KEY, 'nhẹ', 1_000);

      expect(cache.lookup(KEY, 1_000)).toBeDefined();
      expect(
        cache.lookup(KEY, 1_000 + DEFAULT_EXPLAIN_CACHE_TTL_MS - 1),
      ).toBeDefined();
      expect(cache.lookup(KEY, 1_000 + DEFAULT_EXPLAIN_CACHE_TTL_MS)).toBeUndefined();
    });

    it('frees the slot of an expired entry instead of leaving it to rot', async () => {
      await resolved(cache, KEY, 'nhẹ', 1_000);
      expect(cache.size()).toBe(1);

      expect(cache.lookup(KEY, 1_000 + DEFAULT_EXPLAIN_CACHE_TTL_MS)).toBeUndefined();
      expect(cache.size()).toBe(0);
    });

    it('honours a short TTL from env', async () => {
      process.env.EXPLAIN_CACHE_TTL_MS = '1000';
      const shortLived = new ExplainCacheService();
      await resolved(shortLived, KEY, 'nhẹ');

      expect(shortLived.lookup(KEY, 999)).toBeDefined();
      expect(shortLived.lookup(KEY, 1_000)).toBeUndefined();
    });
  });

  describe('LRU bound', () => {
    it('evicts the least recently used entry when full', async () => {
      process.env.EXPLAIN_CACHE_MAX_ENTRIES = '2';
      const small = new ExplainCacheService();

      await resolved(small, { ...KEY, word: 'a' }, 'a');
      await resolved(small, { ...KEY, word: 'b' }, 'b');
      await resolved(small, { ...KEY, word: 'c' }, 'c');

      expect(small.size()).toBe(2);
      expect(small.lookup({ ...KEY, word: 'a' }, 1)).toBeUndefined();
      expect(small.lookup({ ...KEY, word: 'b' }, 1)).toBeDefined();
      expect(small.lookup({ ...KEY, word: 'c' }, 1)).toBeDefined();
    });

    it('counts a read as a use, so a re-read entry is not the next victim', async () => {
      process.env.EXPLAIN_CACHE_MAX_ENTRIES = '2';
      const small = new ExplainCacheService();

      await resolved(small, { ...KEY, word: 'a' }, 'a');
      await resolved(small, { ...KEY, word: 'b' }, 'b');
      expect(small.lookup({ ...KEY, word: 'a' }, 1)).toBeDefined();
      await resolved(small, { ...KEY, word: 'c' }, 'c');

      expect(small.lookup({ ...KEY, word: 'a' }, 1)).toBeDefined();
      expect(small.lookup({ ...KEY, word: 'b' }, 1)).toBeUndefined();
    });

    it('never grows past the cap no matter how many keys arrive', async () => {
      process.env.EXPLAIN_CACHE_MAX_ENTRIES = '3';
      const small = new ExplainCacheService();

      for (let i = 0; i < 50; i++) {
        await resolved(small, { ...KEY, word: `w${i}` }, `w${i}`);
      }

      expect(small.size()).toBe(3);
      expect(small.lookup({ ...KEY, word: 'w49' }, 1)).toBeDefined();
    });
  });

  describe('in-flight coalescing', () => {
    it('runs the provider once for concurrent callers and gives all of them the same value', async () => {
      const run = jest.fn().mockResolvedValue(explanation('nhẹ'));

      const results = await Promise.all([
        cache.track(KEY, run, () => 0),
        cache.track(KEY, run, () => 0),
        cache.track(KEY, run, () => 0),
      ]);

      expect(run).toHaveBeenCalledTimes(1);
      expect(results).toEqual([explanation('nhẹ'), explanation('nhẹ'), explanation('nhẹ')]);
    });

    it('exposes the pending promise while in flight and forgets it after', async () => {
      expect(cache.inflight(KEY)).toBeUndefined();

      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const run = jest.fn(async () => {
        await gate;
        return explanation('nhẹ');
      });

      const first = cache.track(KEY, run, () => 0);
      expect(cache.inflight(KEY)).toBeDefined();
      expect(cache.pendingCount()).toBe(1);
      expect(cache.track(KEY, run, () => 0)).toBe(first);
      await Promise.resolve();
      expect(run).toHaveBeenCalledTimes(1);

      release();
      await first;

      expect(cache.inflight(KEY)).toBeUndefined();
      expect(cache.pendingCount()).toBe(0);
    });

    it('keeps different keys independent', async () => {
      const run = jest.fn(async () => explanation('nhẹ'));

      await Promise.all([
        cache.track(KEY, run, () => 0),
        cache.track({ ...KEY, word: 'lights' }, run, () => 0),
      ]);

      expect(run).toHaveBeenCalledTimes(2);
    });

    it('stores the result so the next caller is a plain cache hit', async () => {
      const run = jest.fn().mockResolvedValue(explanation('nhẹ'));
      await cache.track(KEY, run, () => 0);

      expect(cache.lookup(KEY, 1)).toEqual(explanation('nhẹ'));
    });
  });

  describe('failure cleanup', () => {
    it('does not cache a failure and clears the in-flight slot', async () => {
      const failure = new Error('provider exploded');
      await expect(
        cache.track(KEY, async () => Promise.reject(failure), () => 0),
      ).rejects.toBe(failure);

      expect(cache.size()).toBe(0);
      expect(cache.inflight(KEY)).toBeUndefined();
      expect(cache.pendingCount()).toBe(0);
    });

    it('lets a later attempt retry instead of inheriting the rejected promise', async () => {
      await expect(
        cache.track(KEY, async () => Promise.reject(new Error('boom')), () => 0),
      ).rejects.toThrow('boom');

      const run = jest.fn().mockResolvedValue(explanation('nhẹ'));
      await expect(cache.track(KEY, run, () => 0)).resolves.toEqual(
        explanation('nhẹ'),
      );
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('spreads a failure to every coalesced waiter', async () => {
      const run = jest.fn().mockRejectedValue(new Error('boom'));

      const settled = await Promise.allSettled([
        cache.track(KEY, run, () => 0),
        cache.track(KEY, run, () => 0),
      ]);

      expect(run).toHaveBeenCalledTimes(1);
      expect(settled.map((s) => s.status)).toEqual(['rejected', 'rejected']);
      expect(cache.pendingCount()).toBe(0);
    });
  });
});
