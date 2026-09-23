import { Test, TestingModule } from '@nestjs/testing';
import { AudioGateway } from './audio.gateway';
import { SidecarService } from './sidecar/sidecar.service';
import { TranscriptService } from './transcript/transcript.service';
import { VideoClockService } from './clock/video-clock.service';
import { TranslateService } from '../ai/translate.service';

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

    it('spaces consecutive requests so the RPM ceiling is never exceeded', async () => {
      internals.enqueueForTranslation([{ captionStart: 1, text: 'one' }]);
      await jest.runOnlyPendingTimersAsync();
      expect(translateBatch).toHaveBeenCalledTimes(1);

      // Nhóm mới về ngay sau đó — phải bị giữ lại, không được bắn ngay.
      internals.enqueueForTranslation([{ captionStart: 2, text: 'two' }]);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(translateBatch).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(4_000);
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
      translateBatch.mockRejectedValue(new Error('HTTP 503'));

      for (let round = 0; round < 5; round++) {
        internals.enqueueForTranslation([{ captionStart: 9, text: 'retry me' }]);
        await jest.runOnlyPendingTimersAsync();
        await jest.advanceTimersByTimeAsync(4_000);
      }

      // 5 vòng nhưng chỉ 3 lần thử, rồi bỏ hẳn.
      expect(translateBatch).toHaveBeenCalledTimes(3);
    });
  });
});
