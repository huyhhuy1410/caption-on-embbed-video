import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { ExplainController } from './explain.controller';
import { ExplainService } from './explain.service';
import { ExplainCacheService } from './explain-cache.service';
import {
  TranslationRateLimiter,
  TRANSLATE_MAX_PER_WINDOW,
} from './translation-rate-limiter.service';
import { ProviderUnavailableError } from './errors';
import { WordExplanation } from './types/word-explanation';

const OK: WordExplanation = {
  word: 'context',
  meaning: 'bối cảnh',
  translation: 'bối cảnh',
  example: 'In this context, ...',
  pronunciation: null,
};

const REQUEST = { word: 'context', context: 'in this context', lang: 'vi' };

describe('ExplainController', () => {
  let controller: ExplainController;
  let limiter: TranslationRateLimiter;
  let cache: ExplainCacheService;
  let explainWord: jest.Mock;

  beforeEach(async () => {
    explainWord = jest.fn().mockResolvedValue(OK);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ExplainController],
      providers: [
        {
          provide: ExplainService,
          useValue: { explainWord, providerName: 'test-provider' },
        },
        ExplainCacheService,
        TranslationRateLimiter,
      ],
    }).compile();

    controller = module.get(ExplainController);
    limiter = module.get(TranslationRateLimiter);
    cache = module.get(ExplainCacheService);
  });

  it('forwards to the service and records the call against the shared window', async () => {
    const result = await controller.explainWord(REQUEST);

    expect(result).toEqual(OK);
    expect(limiter.callsInWindow()).toBe(1);
  });

  it('returns 429 without calling the provider when the window is full', async () => {
    for (let i = 0; i < 15; i++) limiter.recordCall();

    await expect(controller.explainWord(REQUEST)).rejects.toBeInstanceOf(
      HttpException,
    );

    expect(explainWord).not.toHaveBeenCalled();
    expect(limiter.callsInWindow()).toBe(15);
  });

  it('pauses the shared limiter when the provider reports quota exhaustion', async () => {
    explainWord.mockRejectedValue(
      new ProviderUnavailableError('HTTP 429', 22_000, false),
    );

    const error = (await controller
      .explainWord(REQUEST)
      .catch((e: unknown) => e)) as unknown as HttpException;

    expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(limiter.tryAcquire()).toBeGreaterThan(0);
  });

  it('returns 503 and does NOT pause the limiter for a retryable provider error', async () => {
    explainWord.mockRejectedValue(
      new ProviderUnavailableError('HTTP 503', 1_000, true),
    );

    const error = (await controller
      .explainWord(REQUEST)
      .catch((e: unknown) => e)) as unknown as HttpException;

    expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(limiter.msUntilRoom()).toBe(0);
  });

  describe('cache before quota', () => {
    it('serves a repeated word from cache without spending quota or calling the provider', async () => {
      await controller.explainWord(REQUEST);
      expect(limiter.callsInWindow()).toBe(1);

      const again = await controller.explainWord(REQUEST);

      expect(again).toEqual(OK);
      expect(explainWord).toHaveBeenCalledTimes(1);
      expect(limiter.callsInWindow()).toBe(1);
    });

    it('serves a cache hit even while the shared window is full', async () => {
      await controller.explainWord(REQUEST);
      for (let i = 1; i < TRANSLATE_MAX_PER_WINDOW; i++) limiter.recordCall();
      expect(limiter.callsInWindow()).toBe(TRANSLATE_MAX_PER_WINDOW);

      await expect(controller.explainWord(REQUEST)).resolves.toEqual(OK);
      expect(limiter.callsInWindow()).toBe(TRANSLATE_MAX_PER_WINDOW);
    });

    it('still returns 429 for an uncached word when the window is full', async () => {
      for (let i = 0; i < 15; i++) limiter.recordCall();

      await expect(
        controller.explainWord({ ...REQUEST, word: 'novel' }),
      ).rejects.toBeInstanceOf(HttpException);
      expect(explainWord).not.toHaveBeenCalled();
    });

    it('does not cache a failed call, so a retry can still reach the provider', async () => {
      explainWord.mockRejectedValueOnce(
        new ProviderUnavailableError('HTTP 503', 1_000, true),
      );
      await expect(controller.explainWord(REQUEST)).rejects.toBeInstanceOf(
        HttpException,
      );

      await expect(controller.explainWord(REQUEST)).resolves.toEqual(OK);
      expect(explainWord).toHaveBeenCalledTimes(2);
    });
  });

  describe('in-flight coalescing', () => {
    it('coalesces concurrent identical requests into one provider call and one quota slot', async () => {
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      explainWord.mockImplementation(async () => {
        await gate;
        return OK;
      });

      const all = Promise.all([
        controller.explainWord(REQUEST),
        controller.explainWord(REQUEST),
        controller.explainWord(REQUEST),
      ]);
      release();

      await expect(all).resolves.toEqual([OK, OK, OK]);
      expect(explainWord).toHaveBeenCalledTimes(1);
      expect(limiter.callsInWindow()).toBe(1);
    });

    it('gives a coalesced waiter the same 429 as the first caller', async () => {
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      explainWord.mockImplementation(async () => {
        await gate;
        throw new ProviderUnavailableError('HTTP 429', 20_000, false);
      });

      const first = controller.explainWord(REQUEST).catch((e: unknown) => e);
      const second = controller.explainWord(REQUEST).catch((e: unknown) => e);
      release();

      const [a, b] = await Promise.all([first, second]);
      expect((a as HttpException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
      expect((b as HttpException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
      expect(explainWord).toHaveBeenCalledTimes(1);
      expect(limiter.tryAcquire()).toBeGreaterThan(0);
    });

    it('does not coalesce different words', async () => {
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      explainWord.mockImplementation(async () => {
        await gate;
        return OK;
      });

      const all = Promise.all([
        controller.explainWord({ ...REQUEST, word: 'light' }),
        controller.explainWord({ ...REQUEST, word: 'lights' }),
      ]);
      release();

      await all;
      expect(explainWord).toHaveBeenCalledTimes(2);
    });

    it('clears the in-flight slot after a failure so the next click retries', async () => {
      explainWord.mockRejectedValueOnce(new Error('socket hang up'));

      await expect(controller.explainWord(REQUEST)).rejects.toThrow(
        'socket hang up',
      );
      expect(cache.pendingCount()).toBe(0);

      await expect(controller.explainWord(REQUEST)).resolves.toEqual(OK);
      expect(explainWord).toHaveBeenCalledTimes(2);
    });
  });
});
