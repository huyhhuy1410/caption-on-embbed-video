import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { TranslateController } from './translate.controller';
import { TranslateService } from './translate.service';
import { TranslationRateLimiter } from './translation-rate-limiter.service';

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
        // Service THẬT — đây chính là thứ đang được kiểm chứng.
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
    // ⚠️ Điểm mấu chốt của Issue 5.14: request HTTP PHẢI được ghi vào cùng bộ
    // đếm mà gateway dùng, nếu không trần thật là tổng của hai bộ đếm rời nhau.
    expect(limiter.callsInWindow()).toBe(1);
  });

  it('returns 429 instead of calling the provider when the window is full', async () => {
    for (let i = 0; i < 15; i++) limiter.recordCall();

    await expect(
      controller.translate({ sentence: 'Hello', from: 'en', to: 'vi' }),
    ).rejects.toBeInstanceOf(HttpException);

    // Không được tiêu quota của provider khi đã biết chắc sẽ bị từ chối.
    expect(translate).not.toHaveBeenCalled();
    expect(limiter.callsInWindow()).toBe(15);
  });

  it('reports how long to wait in the 429 body', async () => {
    for (let i = 0; i < 15; i++) limiter.recordCall();

    const error = await controller
      .translate({ sentence: 'Hello', from: 'en', to: 'vi' })
      .catch((e: unknown) => e as HttpException);

    expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(error.getResponse()).toMatchObject({
      retryAfterMs: expect.any(Number),
    });
  });
});
