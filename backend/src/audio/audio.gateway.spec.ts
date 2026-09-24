import { Test, TestingModule } from '@nestjs/testing';
import { AudioGateway } from './audio.gateway';
import { SidecarService } from './sidecar/sidecar.service';
import { TranscriptService } from './transcript/transcript.service';
import { VideoClockService } from './clock/video-clock.service';
import { TranslateService } from '../ai/translate.service';
import { ProviderUnavailableError } from '../ai/errors';
import { TranslationRateLimiter } from '../ai/translation-rate-limiter.service';

/** Truy cập method private để test hàng đợi mà không phải dựng cả WS. */
type GatewayInternals = {
  enqueueForTranslation(groups: { captionStart: number; text: string }[]): void;
};

describe('AudioGateway', () => {
  let gateway: AudioGateway;
  let internals: GatewayInternals;
  let translateBatch: jest.Mock;

  beforeEach(async () => {
    translateBatch = jest.fn().mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AudioGateway,
        { provide: SidecarService, useValue: { setMessageHandler: jest.fn() } },
        TranscriptService,
        VideoClockService,
        TranslationRateLimiter,
        {
          provide: TranslateService,
          useValue: { translate: jest.fn(), translateBatch },
        },
      ],
    }).compile();

    gateway = module.get<AudioGateway>(AudioGateway);
    internals = gateway as unknown as GatewayInternals;
  });

  it('should be defined', () => {
    expect(gateway).toBeDefined();
  });

  describe('batching', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('batches groups enqueued together into ONE request', async () => {
      // Đây là toàn bộ lý do hàng đợi tồn tại: 3 nhóm ⇒ 1 request, không phải 3.
      internals.enqueueForTranslation([
        { captionStart: 1, text: 'one' },
        { captionStart: 2, text: 'two' },
        { captionStart: 3, text: 'three' },
      ]);

      await jest.runOnlyPendingTimersAsync();

      expect(translateBatch).toHaveBeenCalledTimes(1);
      expect(translateBatch).toHaveBeenCalledWith(
        ['one', 'two', 'three'],
        'vi',
        'en',
      );
    });

    it('never exceeds the per-minute request ceiling, even under a 503 storm', async () => {
      // ⚠️ Đây là bug đã đo được: throttle theo KHOẢNG CÁCH giữa các lượt drain
      // cho ra 26 request/phút, vì mỗi drain tự thử lại 3 lần bên trong. Giờ
      // throttle đếm SỐ REQUEST trong cửa sổ 60s, và retry nằm ở gateway.
      translateBatch.mockRejectedValue(
        new ProviderUnavailableError('HTTP 503', 1_000, true),
      );

      // Ghi lại MỐC THỜI GIAN từng request để kiểm tra đúng bất biến.
      const callTimes: number[] = [];
      translateBatch.mockImplementation(async () => {
        callTimes.push(Date.now());
        throw new ProviderUnavailableError('HTTP 503', 1_000, true);
      });

      // Caption về liên tục trong 4 phút, dày hơn nhịp thật.
      for (let t = 0; t < 240; t++) {
        internals.enqueueForTranslation([{ captionStart: 100 + t, text: 'x' }]);
        await jest.advanceTimersByTimeAsync(1_000);
      }

      expect(callTimes.length).toBeGreaterThan(30);

      // ⚠️ Bất biến thật: KHÔNG cửa sổ 60s nào chứa quá 15 request. Đây đúng
      // là cách provider đếm quota, khác hẳn "tổng số chia cho số phút".
      for (const at of callTimes) {
        const inWindow = callTimes.filter((t) => t > at - 60_000 && t <= at);
        expect(inWindow.length).toBeLessThanOrEqual(15);
      }
    });

    it('holds a request back until the window frees up', async () => {
      internals.enqueueForTranslation([{ captionStart: 1, text: 'one' }]);
      await jest.advanceTimersByTimeAsync(1);
      expect(translateBatch).toHaveBeenCalledTimes(1);

      // Nhóm mới về ngay sau đó — còn quota nên được bắn, nhưng không chồng lên.
      internals.enqueueForTranslation([{ captionStart: 2, text: 'two' }]);
      await jest.advanceTimersByTimeAsync(1);
      expect(translateBatch).toHaveBeenCalledTimes(2);
    });

    it('keeps only the newest text when a group is re-enqueued', async () => {
      // Sidecar cắt nhóm ngang ranh giới window: lần đầu nửa câu, lần sau đủ.
      internals.enqueueForTranslation([{ captionStart: 7, text: 'the model' }]);
      internals.enqueueForTranslation([{ captionStart: 7, text: 'the model overfits' }]);

      await jest.runOnlyPendingTimersAsync();

      expect(translateBatch).toHaveBeenCalledWith(
        ['the model overfits'],
        'vi',
        'en',
      );
    });

    it('gives up on a group after 3 failed attempts', async () => {
      // Lỗi thuộc về chính batch (400/401/500...) ⇒ đếm công rồi bỏ.
      translateBatch.mockRejectedValue(new Error('HTTP 500'));

      for (let round = 0; round < 5; round++) {
        internals.enqueueForTranslation([{ captionStart: 9, text: 'retry me' }]);
        await jest.runOnlyPendingTimersAsync();
        await jest.advanceTimersByTimeAsync(4_000);
      }

      // 5 vòng nhưng chỉ 3 lần thử, rồi bỏ hẳn.
      expect(translateBatch).toHaveBeenCalledTimes(3);
    });

    it('never runs two requests at once, even when a request is slow', async () => {
      // Đây là bug đã gây bão 429: `drainTimer` bị xoá lúc timer NỔ nên không
      // còn gì chặn trong khi một drain đang await. Cờ `draining` phải giữ đúng 1.
      let concurrent = 0;
      let peak = 0;
      translateBatch.mockImplementation(async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        concurrent -= 1;
        return [];
      });

      internals.enqueueForTranslation([{ captionStart: 1, text: 'a' }]);
      await jest.advanceTimersByTimeAsync(1);

      // Caption vẫn về trong lúc request đầu còn đang chạy.
      for (let t = 0; t < 4; t++) {
        internals.enqueueForTranslation([{ captionStart: 10 + t, text: 'x' }]);
        await jest.advanceTimersByTimeAsync(4_000);
      }

      expect(peak).toBe(1);
    });

    it('holds sentences through a quota cooldown instead of dropping them', async () => {
      translateBatch.mockRejectedValueOnce(
        new ProviderUnavailableError('HTTP 429', 22_000),
      );

      internals.enqueueForTranslation([{ captionStart: 5, text: 'hold me' }]);
      await jest.runOnlyPendingTimersAsync();
      expect(translateBatch).toHaveBeenCalledTimes(1);

      // Trong cửa sổ cooldown: chưa được gọi lại.
      await jest.advanceTimersByTimeAsync(20_000);
      expect(translateBatch).toHaveBeenCalledTimes(1);

      // Qua cooldown thì thử lại ĐÚNG câu đó — đã re-queue nên không mất.
      translateBatch.mockResolvedValue([
        { text: 'giu toi', from: 'en', to: 'vi' },
      ]);
      await jest.advanceTimersByTimeAsync(3_000);
      expect(translateBatch).toHaveBeenCalledTimes(2);
      expect(translateBatch).toHaveBeenLastCalledWith(['hold me'], 'vi', 'en');
    });
  });
});
