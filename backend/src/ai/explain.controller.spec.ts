import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { ExplainController } from './explain.controller';
import { ExplainService } from './explain.service';
import { TranslationRateLimiter } from './translation-rate-limiter.service';
import { ProviderUnavailableError } from './errors';
import { WordExplanation } from './types/word-explanation';

const OK: WordExplanation = {
  word: 'context',
  meaning: 'bối cảnh',
  translation: 'bối cảnh',
  example: 'In this context, ...',
  pronunciation: null,
};

describe('ExplainController', () => {
  let controller: ExplainController;
  let limiter: TranslationRateLimiter;
  let explainWord: jest.Mock;

  beforeEach(async () => {
    explainWord = jest.fn().mockResolvedValue(OK);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ExplainController],
      providers: [
        { provide: ExplainService, useValue: { explainWord } },
        // Service THẬT — đây chính là thứ đang được kiểm chứng.
        TranslationRateLimiter,
      ],
    }).compile();

    controller = module.get(ExplainController);
    limiter = module.get(TranslationRateLimiter);
  });

  it('forwards to the service and records the call against the shared window', async () => {
    const result = await controller.explainWord({
      word: 'context',
      context: 'in this context',
      lang: 'vi',
    });

    expect(result).toEqual(OK);
    // ⚠️ Điểm mấu chốt của Issue 5.16: /explain-word dùng CHUNG Gemini instance
    // (cùng key, cùng model) với /translate và caption, nên PHẢI ghi vào cùng bộ
    // đếm — không thì mỗi click vào một từ là một request Gemini ẩn.
    expect(limiter.callsInWindow()).toBe(1);
  });

  it('returns 429 without calling the provider when the window is full', async () => {
    for (let i = 0; i < 15; i++) limiter.recordCall();

    await expect(
      controller.explainWord({ word: 'context', context: 'x', lang: 'vi' }),
    ).rejects.toBeInstanceOf(HttpException);

    expect(explainWord).not.toHaveBeenCalled();
    expect(limiter.callsInWindow()).toBe(15);
  });

  it('pauses the shared limiter when the provider reports quota exhaustion', async () => {
    explainWord.mockRejectedValue(
      new ProviderUnavailableError('HTTP 429', 22_000, false),
    );

    const error = (await controller
      .explainWord({ word: 'context', context: 'x', lang: 'vi' })
      .catch((e: unknown) => e)) as unknown as HttpException;

    expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    // Xem giải thích cùng kiểu ở translate.controller.spec.ts: phải hỏi qua
    // `tryAcquire` vì đó là lời gọi mà request kế tiếp thật sự dùng.
    expect(limiter.tryAcquire()).toBeGreaterThan(0);
  });

  it('returns 503 and does NOT pause the limiter for a retryable provider error', async () => {
    // 503 là lỗi của chính request đó, không phải quota của project ⇒ không
    // được khoá các đường khác, và HTTP status phải là 503 chứ không phải 429.
    explainWord.mockRejectedValue(
      new ProviderUnavailableError('HTTP 503', 1_000, true),
    );

    const error = (await controller
      .explainWord({ word: 'context', context: 'x', lang: 'vi' })
      .catch((e: unknown) => e)) as unknown as HttpException;

    expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(limiter.msUntilRoom()).toBe(0);
  });
});
