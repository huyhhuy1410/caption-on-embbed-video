import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { TranslateController } from './translate.controller';
import { TranslateService } from './translate.service';
import { TranslationRateLimiter } from './translation-rate-limiter.service';
import { ProviderUnavailableError } from './errors';

describe('TranslateController', () => {
  let controller: TranslateController;
  let limiter: TranslationRateLimiter;
  let translate: jest.Mock;

  beforeEach(async () => {
    translate = jest.fn().mockResolvedValue({ text: 'Xin chào' });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TranslateController],
      providers: [
        { provide: TranslateService, useValue: { translate } },
        // The REAL service — this is what the test verifies.
        TranslationRateLimiter,
      ],
    }).compile();

    controller = module.get(TranslateController);
    limiter = module.get(TranslationRateLimiter);
  });

  it('translates and records the call against the shared window', async () => {
    const result = await controller.translate({
      sentence: 'Hello',
      from: 'en',
      to: 'vi',
    });

    expect(result).toEqual({ text: 'Xin chào' });
    // Issue 5.14: the HTTP request MUST be recorded in the same counter the
    // gateway uses, or the real ceiling is the sum of two separate counters.
    expect(limiter.callsInWindow()).toBe(1);
  });

  it('returns 429 instead of calling the provider when the window is full', async () => {
    for (let i = 0; i < 15; i++) limiter.recordCall();

    await expect(
      controller.translate({ sentence: 'Hello', from: 'en', to: 'vi' }),
    ).rejects.toBeInstanceOf(HttpException);

    // Must not spend provider quota on a request certain to be rejected.
    expect(translate).not.toHaveBeenCalled();
    expect(limiter.callsInWindow()).toBe(15);
  });

  it('reports how long to wait in the 429 body', async () => {
    for (let i = 0; i < 15; i++) limiter.recordCall();

    const error = (await controller
      .translate({ sentence: 'Hello', from: 'en', to: 'vi' })
      .catch((e: unknown) => e)) as unknown as HttpException;

    expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(error.getResponse()).toMatchObject({
      retryAfterMs: expect.any(Number),
    });
  });

  it('pauses the shared limiter when the provider reports quota exhaustion', async () => {
    // The hole review found: a provider quota-exhaustion on the HTTP path used to
    // leave the WebSocket path burning quota, and the caller got 500 instead of 429.
    translate.mockRejectedValue(
      new ProviderUnavailableError('HTTP 429', 22_000, false),
    );

    const error = (await controller
      .translate({ sentence: 'Hello', from: 'en', to: 'vi' })
      .catch((e: unknown) => e)) as unknown as HttpException;

    expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    // The window has room (1 request) but the global cooldown must still block;
    // `tryAcquire` uses `msUntilRoom()`, so this mirrors what the next request
    // (caption or /explain-word) will see.
    expect(limiter.tryAcquire()).toBeGreaterThan(0);
  });

  it('does not pause the limiter for a retryable provider error', async () => {
    // A 503 is that request's own failure, not the project's quota ⇒ it must not
    // lock the WebSocket path.
    translate.mockRejectedValue(
      new ProviderUnavailableError('HTTP 503', 1_000, true),
    );

    await expect(
      controller.translate({ sentence: 'Hello', from: 'en', to: 'vi' }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);

    expect(limiter.msUntilRoom()).toBe(0);
  });
});
