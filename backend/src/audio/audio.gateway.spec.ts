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

/**
 * Client giả cho WebSocket của extension.
 *
 * ⚠️ Phải giữ lại CẢ HAI chiều mới test được đường seek: gateway nhận vào qua
 * `client.on('message')` và trả ra qua `client.send`. Một mock chỉ có `on()`
 * rỗng thì không bắn được message nào vào, và không đọc được `replay` bắn ra.
 */
type FakeClient = {
  readyState: number;
  sent: { type?: string }[];
  on(event: string, handler: (data: Buffer, isBinary: boolean) => void): void;
  send(payload: string): void;
  emit(event: string, data: Buffer, isBinary: boolean): void;
};

function makeClient(): FakeClient {
  const handlers = new Map<
    string,
    (data: Buffer, isBinary: boolean) => void
  >();
  const sent: { type?: string }[] = [];
  return {
    readyState: 1, // WebSocket.OPEN
    sent,
    on(event, handler) {
      handlers.set(event, handler);
    },
    send(payload: string) {
      sent.push(JSON.parse(payload) as { type?: string });
    },
    emit(event, data, isBinary) {
      handlers.get(event)?.(data, isBinary);
    },
  };
}

/** Bắn một gói JSON text vào gateway, đúng như extension làm. */
function sendToGateway(client: FakeClient, payload: object): void {
  client.emit('message', Buffer.from(JSON.stringify(payload)), false);
}

describe('AudioGateway', () => {
  let gateway: AudioGateway;
  let internals: GatewayInternals;
  let translateBatch: jest.Mock;
  let sidecar: {
    setMessageHandler: jest.Mock;
    sendReset: jest.Mock;
    sendAudio: jest.Mock;
    sendMetadata: jest.Mock;
  };

  beforeEach(async () => {
    translateBatch = jest.fn().mockResolvedValue([]);
    sidecar = {
      setMessageHandler: jest.fn(),
      sendReset: jest.fn(),
      sendAudio: jest.fn(),
      sendMetadata: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AudioGateway,
        { provide: SidecarService, useValue: sidecar },
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

  describe('seek', () => {
    it('tells the sidecar to drop its audio buffer', () => {
      // ⚠️ Issue 5.21: sidecar giữ tới 6s tiếng của đoạn TRƯỚC khi tua. Reset
      // clock ở backend là chưa đủ — không báo xuống thì window kế tiếp trộn
      // tiếng cũ với tiếng mới nhưng dán mốc mới ⇒ phụ đề đúng ngay lúc tua
      // rồi lệch ở đoạn ngay sau.
      const client = makeClient();
      gateway.handleConnection(client as never);

      sendToGateway(client, { type: 'seek', seekTimeAtCapture: 17.72 });

      expect(sidecar.sendReset).toHaveBeenCalledTimes(1);
    });

    it('replays cached words for the sought range', () => {
      // Bằng chứng của Issue 5.19: nhánh seek phải bắn ra message `replay`.
      // Không có nó thì cache backend là code không tới được, và phụ đề sau khi
      // tua chỉ có thể đến từ cache trong RAM của overlay.
      const client = makeClient();
      gateway.handleConnection(client as never);

      sendToGateway(client, { type: 'seek', seekTimeAtCapture: 17.72 });

      expect(client.sent.some((m) => m.type === 'replay')).toBe(true);
    });

    it('does not reset the sidecar for a seek without a time', () => {
      // Gói seek thiếu `seekTimeAtCapture` không đủ dữ liệu để replay; báo sidecar
      // xoá buffer lúc đó là xoá oan.
      const client = makeClient();
      gateway.handleConnection(client as never);

      sendToGateway(client, { type: 'seek' });

      expect(sidecar.sendReset).not.toHaveBeenCalled();
    });
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

    it('does not count a 503 as an attempt, so a provider outage keeps the sentence', async () => {
      // ⚠️ Issue 5.18: 503 là lỗi TẠM THỜI của provider, không tiêu quota. Trước
      // đây nó đi chung nhánh "tính công rồi bỏ" với 400/500, nên một đợt Gemini
      // quá tải vài phút XOÁ VĨNH VIỄN bản dịch của cả đoạn — đúng cái "xoá sổ
      // bản dịch cả video" ở Issue 5.12.
      translateBatch.mockRejectedValue(
        new ProviderUnavailableError('HTTP 503', 1_000, true),
      );

      internals.enqueueForTranslation([{ captionStart: 3, text: 'keep me' }]);

      // Nhiều lượt 503 liên tiếp. Nếu 503 tính công như lỗi vĩnh viễn thì câu bị
      // bỏ sau 3 lượt (MAX_TRANSLATE_ATTEMPTS) và số lượt DỪNG Ở 3 — đó chính
      // là bất biến cần phá. Không assert số lượt tuyệt đối: backoff của
      // provider (1s) không chia hết một lần advance nên đếm dễ sai.
      for (let round = 0; round < 5; round++) {
        await jest.advanceTimersByTimeAsync(1_000);
      }
      expect(translateBatch.mock.calls.length).toBeGreaterThan(3);

      // Provider hồi ⇒ câu vẫn còn trong hàng đợi, dịch được ngay.
      translateBatch.mockResolvedValue([
        { text: 'giu toi', from: 'en', to: 'vi' },
      ]);
      await jest.advanceTimersByTimeAsync(2_000);
      expect(translateBatch).toHaveBeenLastCalledWith(['keep me'], 'vi', 'en');
    });

    it('backs off between 503 retries instead of hammering the provider', async () => {
      // ⚠️ Không có nhánh 503 thì `scheduleDrain` hẹn 0ms (cửa sổ quota vẫn
      // còn chỗ sau 503) ⇒ 503 lặp liên tục, đốt lượt của chính các câu đang
      // chờ trong khi model đã chết.
      translateBatch.mockRejectedValue(
        new ProviderUnavailableError('HTTP 503', 1_000, true),
      );

      internals.enqueueForTranslation([{ captionStart: 4, text: 'slow down' }]);
      // Chỉ 1ms để lượt ĐẦU nổ (cửa sổ quota còn chỗ) — nếu advance 1s thì lượt
      // thứ hai cũng nằm trong cùng lần advance và test không còn ý nghĩa.
      await jest.advanceTimersByTimeAsync(1);
      expect(translateBatch).toHaveBeenCalledTimes(1);

      // Chưa tới mốc provider dặn (1s) ⇒ không thử lại.
      await jest.advanceTimersByTimeAsync(200);
      expect(translateBatch).toHaveBeenCalledTimes(1);

      // Qua mốc thì thử đúng một lượt nữa.
      await jest.advanceTimersByTimeAsync(1_000);
      expect(translateBatch).toHaveBeenCalledTimes(2);
    });

    it('gives up on a sentence held past the transient cap', async () => {
      // Trần giữ tồn tại để một 503 kéo dài vô hạn (model bị thu hồi, key chết)
      // không giữ câu mãi mà không báo ai.
      translateBatch.mockRejectedValue(
        new ProviderUnavailableError('HTTP 503', 1_000, true),
      );

      internals.enqueueForTranslation([{ captionStart: 6, text: 'give up' }]);

      // 5 phút + dư chút (TRANSIENT_HOLD_MAX_MS = 5 * 60_000).
      for (let round = 0; round < 310; round++) {
        await jest.advanceTimersByTimeAsync(1_000);
      }
      const callsAtCap = translateBatch.mock.calls.length;

      // Hết trần ⇒ bỏ câu, hàng đợi rỗng ⇒ không còn lượt nào nữa.
      await jest.advanceTimersByTimeAsync(10_000);
      expect(translateBatch.mock.calls.length).toBe(callsAtCap);
    });
  });
});
