import { Test, TestingModule } from '@nestjs/testing';
import { AudioGateway } from './audio.gateway';
import { SidecarService } from './sidecar/sidecar.service';
import { TranscriptService } from './transcript/transcript.service';
import { VideoClockService } from './clock/video-clock.service';
import { TranslateService } from '../ai/translate.service';
import { ProviderUnavailableError } from '../ai/errors';
import { TranslationRateLimiter } from '../ai/translation-rate-limiter.service';

/** Reach the private method to test the queue without standing up the WS. */
type GatewayInternals = {
  enqueueForTranslation(groups: { captionStart: number; text: string }[]): void;
};

/**
 * Fake WebSocket client for the extension.
 *
 * Both directions are needed to test the seek path: the gateway reads input via
 * `client.on('message')` and writes output via `client.send`. A mock with an empty
 * `on()` can neither push a message in nor capture the `replay` pushed out.
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

/** Push a JSON text frame into the gateway exactly as the extension does. */
function sendToGateway(client: FakeClient, payload: object): void {
  client.emit('message', Buffer.from(JSON.stringify(payload)), false);
}

describe('AudioGateway', () => {
  let gateway: AudioGateway;
  let internals: GatewayInternals;
  let translateBatch: jest.Mock;
  let sidecar: {
    setMessageHandler: jest.Mock;
    setOpenHandler: jest.Mock;
    sendSourceSwitch: jest.Mock;
    sendReset: jest.Mock;
    sendAudio: jest.Mock;
    sendMetadata: jest.Mock;
  };

  beforeEach(async () => {
    translateBatch = jest.fn().mockResolvedValue([]);
    sidecar = {
      setMessageHandler: jest.fn(),
      setOpenHandler: jest.fn(),
      sendSourceSwitch: jest.fn(),
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

  describe('sidecar reconnect', () => {
    it('re-sends only the current video source when the sidecar opens', () => {
      const client = makeClient();
      gateway.handleConnection(client as never);

      sendToGateway(client, { type: 'source-switch', sourceId: 'v1' });
      sendToGateway(client, { type: 'source-switch', sourceId: 'v2' });

      expect(sidecar.setOpenHandler).toHaveBeenCalledTimes(1);
      const onOpen = sidecar.setOpenHandler.mock.calls[0][0] as () => void;
      sidecar.sendSourceSwitch.mockClear();
      onOpen();

      expect(sidecar.sendSourceSwitch).toHaveBeenCalledTimes(1);
      expect(sidecar.sendSourceSwitch).toHaveBeenCalledWith('v2');
    });

    it('does not invent a source before any video is selected', () => {
      const onOpen = sidecar.setOpenHandler.mock.calls[0][0] as () => void;
      onOpen();
      expect(sidecar.sendSourceSwitch).not.toHaveBeenCalled();
    });
  });

  describe('seek', () => {
    it('tells the sidecar to drop its audio buffer', () => {
      // Issue 5.21: the sidecar still holds up to 6s of pre-seek audio. Resetting
      // the backend clock is not enough — without a reset downward the next window
      // mixes old and new audio under new timestamps, so captions are right at the
      // seek and drift just after.
      const client = makeClient();
      gateway.handleConnection(client as never);

      sendToGateway(client, { type: 'seek', seekTimeAtCapture: 17.72 });

      expect(sidecar.sendReset).toHaveBeenCalledTimes(1);
    });

    it('replays cached words for the sought range', () => {
      // Issue 5.19 evidence: the seek branch must emit the `replay` message.
      // Without it the backend cache is unreachable code and post-seek captions
      // can only come from the overlay's in-RAM cache.
      const client = makeClient();
      gateway.handleConnection(client as never);

      sendToGateway(client, { type: 'seek', seekTimeAtCapture: 17.72 });

      expect(client.sent.some((m) => m.type === 'replay')).toBe(true);
    });

    it('does not reset the sidecar for a seek without a time', () => {
      // A seek packet without `seekTimeAtCapture` cannot replay; telling the
      // sidecar to drop its buffer then would discard audio for nothing.
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
      // This is the whole reason the queue exists: 3 groups ⇒ 1 request, not 3.
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
      // Measured bug: throttling by the INTERVAL between drains produced 26
      // requests/minute, because each drain retried 3 times internally. Now the
      // throttle counts REQUESTS per 60s window and retry lives in the gateway.
      translateBatch.mockRejectedValue(
        new ProviderUnavailableError('HTTP 503', 1_000, true),
      );

      // Record each request's TIMESTAMP to check the real invariant.
      const callTimes: number[] = [];
      translateBatch.mockImplementation(async () => {
        callTimes.push(Date.now());
        throw new ProviderUnavailableError('HTTP 503', 1_000, true);
      });

      // Captions arrive continuously for 4 minutes, denser than real traffic.
      for (let t = 0; t < 240; t++) {
        internals.enqueueForTranslation([{ captionStart: 100 + t, text: 'x' }]);
        await jest.advanceTimersByTimeAsync(1_000);
      }

      expect(callTimes.length).toBeGreaterThan(30);

      // The real invariant: NO 60s window holds more than 15 requests. That is how
      // the provider counts quota, unlike "total divided by minutes".
      for (const at of callTimes) {
        const inWindow = callTimes.filter((t) => t > at - 60_000 && t <= at);
        expect(inWindow.length).toBeLessThanOrEqual(15);
      }
    });

    it('holds a request back until the window frees up', async () => {
      internals.enqueueForTranslation([{ captionStart: 1, text: 'one' }]);
      await jest.advanceTimersByTimeAsync(1);
      expect(translateBatch).toHaveBeenCalledTimes(1);

      // A group arrives right after — quota remains, so it fires without overlap.
      internals.enqueueForTranslation([{ captionStart: 2, text: 'two' }]);
      await jest.advanceTimersByTimeAsync(1);
      expect(translateBatch).toHaveBeenCalledTimes(2);
    });

    it('keeps only the newest text when a group is re-enqueued', async () => {
      // The sidecar cuts a group at the window edge: half a sentence first, then the whole one.
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
      // Errors caused by the batch itself (400/401/500...) count as attempts and are dropped.
      translateBatch.mockRejectedValue(new Error('HTTP 500'));

      for (let round = 0; round < 5; round++) {
        internals.enqueueForTranslation([{ captionStart: 9, text: 'retry me' }]);
        await jest.runOnlyPendingTimersAsync();
        await jest.advanceTimersByTimeAsync(4_000);
      }

      // 5 rounds but only 3 attempts, then it is dropped for good.
      expect(translateBatch).toHaveBeenCalledTimes(3);
    });

    it('never runs two requests at once, even when a request is slow', async () => {
      // The bug that caused a 429 storm: `drainTimer` was cleared when the timer
      // FIRED, leaving nothing to block while a drain was still awaiting. The
      // `draining` flag must hold concurrency at exactly 1.
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

      // Captions keep arriving while the first request is still in flight.
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

      // Inside the cooldown window: no retry yet.
      await jest.advanceTimersByTimeAsync(20_000);
      expect(translateBatch).toHaveBeenCalledTimes(1);

      // Past the cooldown it retries THAT exact sentence — re-queued, so nothing is lost.
      translateBatch.mockResolvedValue([
        { text: 'giu toi', from: 'en', to: 'vi' },
      ]);
      await jest.advanceTimersByTimeAsync(3_000);
      expect(translateBatch).toHaveBeenCalledTimes(2);
      expect(translateBatch).toHaveBeenLastCalledWith(['hold me'], 'vi', 'en');
    });

    it('does not count a 503 as an attempt, so a provider outage keeps the sentence', async () => {
      // Issue 5.18: 503 is a TRANSIENT provider error and spends no quota.
      // It used to share the "count an attempt and drop" branch with 400/500,
      // so a few minutes of Gemini overload PERMANENTLY deleted a whole
      // paragraph's translations — the "wipe the video's translations" of Issue 5.12.
      translateBatch.mockRejectedValue(
        new ProviderUnavailableError('HTTP 503', 1_000, true),
      );

      internals.enqueueForTranslation([{ captionStart: 3, text: 'keep me' }]);

      // Repeated 503s. If a 503 counted as a permanent failure the sentence would be
      // dropped after 3 attempts (MAX_TRANSLATE_ATTEMPTS) and the call count would
      // STOP AT 3 — the invariant this test breaks. No absolute count assertion:
      // the provider backoff (1s) does not divide evenly into one advance, so counting slips.
      for (let round = 0; round < 5; round++) {
        await jest.advanceTimersByTimeAsync(1_000);
      }
      expect(translateBatch.mock.calls.length).toBeGreaterThan(3);

      // Provider recovers ⇒ the sentence is still queued and translates immediately.
      translateBatch.mockResolvedValue([
        { text: 'giu toi', from: 'en', to: 'vi' },
      ]);
      await jest.advanceTimersByTimeAsync(2_000);
      expect(translateBatch).toHaveBeenLastCalledWith(['keep me'], 'vi', 'en');
    });

    it('backs off between 503 retries instead of hammering the provider', async () => {
      // Without the 503 branch, `scheduleDrain` schedules 0ms (the quota window
      // still has room after a 503) ⇒ 503s repeat endlessly, burning the quota of
      // the very sentences waiting while the model is down.
      translateBatch.mockRejectedValue(
        new ProviderUnavailableError('HTTP 503', 1_000, true),
      );

      internals.enqueueForTranslation([{ captionStart: 4, text: 'slow down' }]);
      // Only 1ms so the FIRST attempt fires (the quota window still has room) — advancing
      // 1s would put the second attempt in the same advance and the test would prove nothing.
      await jest.advanceTimersByTimeAsync(1);
      expect(translateBatch).toHaveBeenCalledTimes(1);

      // Before the deadline the provider set (1s) ⇒ no retry.
      await jest.advanceTimersByTimeAsync(200);
      expect(translateBatch).toHaveBeenCalledTimes(1);

      // Past the deadline it retries exactly once more.
      await jest.advanceTimersByTimeAsync(1_000);
      expect(translateBatch).toHaveBeenCalledTimes(2);
    });

    it('gives up on a sentence held past the transient cap', async () => {
      // The hold cap exists so an endless 503 (model retired, dead key) cannot keep
      // a sentence forever without telling anyone.
      translateBatch.mockRejectedValue(
        new ProviderUnavailableError('HTTP 503', 1_000, true),
      );

      internals.enqueueForTranslation([{ captionStart: 6, text: 'give up' }]);

      // 5 minutes plus a bit (TRANSIENT_HOLD_MAX_MS = 5 * 60_000).
      for (let round = 0; round < 310; round++) {
        await jest.advanceTimersByTimeAsync(1_000);
      }
      const callsAtCap = translateBatch.mock.calls.length;

      // Cap reached ⇒ the sentence is dropped, the queue empties, no further calls.
      await jest.advanceTimersByTimeAsync(10_000);
      expect(translateBatch.mock.calls.length).toBe(callsAtCap);
    });
  });
});
