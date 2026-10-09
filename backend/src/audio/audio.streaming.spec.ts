import { AudioGateway } from './audio.gateway';
import { TranscriptService } from './transcript/transcript.service';
import { VideoClockService } from './clock/video-clock.service';
import { TranslationRateLimiter } from '../ai/translation-rate-limiter.service';
import { SidecarService } from './sidecar/sidecar.service';
import { TranslateService } from '../ai/translate.service';
import { WebSocket } from 'ws';
import { SourceIdentity } from '../../../extension/src/content/source-identity';
import { SnapshotStore } from '../../../extension/src/shared/snapshot-store';
const scope = { sessionId: 's1', generation: 1, sourceId: 'v1' };
function client() {
  const sent: any[] = [];
  let handler: (data: Buffer, binary: boolean) => void;
  const c = {
    readyState: 1,
    send: (s: string) => sent.push(JSON.parse(s)),
    on: (event: string, fn: any) => {
      if (event === 'message') handler = fn;
    },
  };
  return {
    c: c as unknown as WebSocket,
    sent,
    send: (data: object) => handler(Buffer.from(JSON.stringify(data)), false),
    audio: () => handler(Buffer.alloc(32000), true),
  };
}
function words(finalized = false, overrides = {}) {
  return {
    ...scope,
    type: 'words',
    mode: 'streaming',
    revision: finalized ? 2 : 1,
    words: [
      {
        wordId: 'w1',
        captionId: 'c1',
        w: 'hello',
        s: 0,
        e: 1,
        videoStart: 10,
        videoEnd: 11,
        captionStart: 10,
        c: 1,
        provisional: !finalized,
        sourceId: 'v1',
      },
    ],
    captions: [
      { captionId: 'c1', captionStart: 10, wordIds: ['w1'], finalized },
    ],
    removedWordIds: [],
    removedCaptionIds: [],
    ...overrides,
  };
}
describe('scoped audio gateway', () => {
  let sidecar: any;
  let transcript: TranscriptService;
  let translateBatch: jest.Mock;
  let gateway: AudioGateway;
  let receive: (s: string) => void;
  const previousMode = process.env.CAPTION_MODE;
  beforeEach(() => {
    process.env.CAPTION_MODE = 'streaming';
    jest.useFakeTimers();
    sidecar = {
      setOpenHandler: jest.fn(),
      setMessageHandler: (fn: any) => (receive = fn),
      sendControl: jest.fn(),
      sendMetadata: jest.fn().mockReturnValue(true),
      sendAudio: jest.fn(),
    };
    transcript = new TranscriptService();
    translateBatch = jest.fn().mockResolvedValue([{ text: 'xin chao' }]);
    gateway = new AudioGateway(
      sidecar as SidecarService,
      transcript,
      new VideoClockService(),
      { translateBatch } as unknown as TranslateService,
      new TranslationRateLimiter(),
    );
  });
  afterEach(() => {
    if (previousMode === undefined) delete process.env.CAPTION_MODE;
    else process.env.CAPTION_MODE = previousMode;
    jest.clearAllTimers();
    jest.useRealTimers();
  });
  it('forwards explicit frame START clock unchanged and discards stale control/audio', () => {
    const c = client();
    gateway.handleConnection(c.c);
    c.send({ ...scope, type: 'source-switch' });
    const frame = {
      ...scope,
      type: 'audio',
      seq: 1,
      frames: 16000,
      sampleRate: 16000,
      frameStartVideoTime: 10,
      videoTimeAtCapture: 11,
      capturedAtEpochMs: 1000,
    };
    c.send(frame);
    c.audio();
    expect(sidecar.sendMetadata).toHaveBeenCalledWith(frame);
    expect(sidecar.sendAudio).toHaveBeenCalledTimes(1);
    c.send({ ...scope, generation: 2, type: 'seek', seekTimeAtCapture: 5 });
    c.send(frame);
    c.audio();
    c.send({ ...scope, type: 'source-switch', sourceId: 'other' });
    expect(sidecar.sendAudio).toHaveBeenCalledTimes(1);
    expect(sidecar.sendControl).toHaveBeenCalledTimes(2);
  });
  it('requires scoped 16 kHz one-second PCM metadata and rejects malformed or unpaired audio', () => {
    const c = client();
    gateway.handleConnection(c.c);
    c.send({ ...scope, type: 'source-switch' });
    const frame = {
      ...scope,
      type: 'audio',
      seq: 1,
      frames: 16000,
      sampleRate: 16000,
      frameStartVideoTime: 10,
      videoTimeAtCapture: 11,
      capturedAtEpochMs: 1000,
    };
    c.audio();
    for (const overrides of [
      { frames: 8000 },
      { sampleRate: 48000 },
      { generation: 0 },
      { sessionId: 'old-session' },
      { sourceId: 'other-source' },
    ]) {
      c.send({ ...frame, ...overrides });
      c.audio();
    }
    expect(sidecar.sendMetadata).not.toHaveBeenCalled();
    expect(sidecar.sendAudio).not.toHaveBeenCalled();
    c.send(frame);
    c.audio();
    c.audio();
    expect(sidecar.sendMetadata).toHaveBeenCalledWith(frame);
    expect(sidecar.sendAudio).toHaveBeenCalledTimes(1);
    expect(sidecar.sendAudio.mock.calls[0][0]).toHaveLength(32000);
  });

  it('preserves windowed legacy anchor resolution with scoped frames', () => {
    process.env.CAPTION_MODE = 'windowed';
    const c = client();
    gateway.handleConnection(c.c);
    c.send({ ...scope, type: 'source-switch' });
    const frame = {
      ...scope,
      type: 'audio',
      seq: 1,
      frames: 16000,
      sampleRate: 16000,
      frameStartVideoTime: 10,
      videoTimeAtCapture: 11,
      capturedAtEpochMs: 1000,
    };
    c.send(frame);
    c.send({
      ...frame,
      seq: 2,
      frameStartVideoTime: 11,
      videoTimeAtCapture: 12,
    });
    expect(sidecar.sendMetadata).toHaveBeenLastCalledWith({
      ...frame,
      seq: 2,
      frameStartVideoTime: 11,
      videoTimeAtCapture: 11,
    });
  });
  it('translates only finalized captions and finalized replay consumes no quota', async () => {
    const c = client();
    gateway.handleConnection(c.c);
    c.send({ ...scope, type: 'source-switch' });
    receive(JSON.stringify(words()));
    await jest.runOnlyPendingTimersAsync();
    expect(translateBatch).not.toHaveBeenCalled();
    receive(JSON.stringify(words(true)));
    await jest.runOnlyPendingTimersAsync();
    expect(translateBatch).toHaveBeenCalledTimes(1);
    c.send({ ...scope, generation: 2, type: 'seek', seekTimeAtCapture: 10.5 });
    const replay = c.sent.find((m) => m.type === 'replay');
    expect(replay.words).toHaveLength(1);
    expect(replay.translations[0].captionId).toBe('c1');
    receive(
      JSON.stringify(
        words(true, {
          generation: 2,
          revision: 1,
          words: [
            { ...words(true).words[0], wordId: 'w-new', captionId: 'c-new' },
          ],
          captions: [
            {
              captionId: 'c-new',
              captionStart: 10,
              wordIds: ['w-new'],
              finalized: true,
            },
          ],
        }),
      ),
    );
    await jest.runOnlyPendingTimersAsync();
    expect(translateBatch).toHaveBeenCalledTimes(1);
    expect(transcript.getRangeFrom('v1', 0)).toHaveLength(1);
  });
  it('caches in-flight translation in original source but never relays after a source/session change', async () => {
    let finish!: (value: any) => void;
    translateBatch.mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const c = client();
    gateway.handleConnection(c.c);
    c.send({ ...scope, type: 'source-switch' });
    receive(JSON.stringify(words(true)));
    await jest.advanceTimersByTimeAsync(1);
    c.send({ ...scope, sourceId: 'v2', generation: 2, type: 'source-switch' });
    finish([{ text: 'xin chao' }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(transcript.getTranslation('v1', 'c1')?.vi).toBe('xin chao');
    expect(transcript.getTranslation('v2', 'c1')).toBeUndefined();
    expect(c.sent.filter((m) => m.type === 'translation')).toEqual([]);
  });
  it('never relays an old session translation to a replacement connection with the same source', async () => {
    let finish!: (value: any) => void;
    translateBatch.mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const c = client();
    gateway.handleConnection(c.c);
    c.send({ ...scope, type: 'source-switch' });
    receive(JSON.stringify(words(true)));
    await jest.advanceTimersByTimeAsync(1);
    const replacement = client();
    gateway.handleConnection(replacement.c);
    replacement.send({ ...scope, sessionId: 's2', type: 'source-switch' });
    finish([{ text: 'xin chao' }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(transcript.getTranslation('v1', 'c1')?.vi).toBe('xin chao');
    expect(replacement.sent.filter((m) => m.type === 'translation')).toEqual(
      [],
    );
  });

  const mediaA = 'https://example.test/A.mp4';
  const mediaB = 'https://example.test/B.mp4';
  const documentScope = (sessionId: string, url: string) => ({
    sessionId,
    generation: 1,
    sourceId: new SourceIdentity().forVideo(
      { currentSrc: url, src: '' },
      'https://example.test/watch',
    ),
  });
  function sourceWords(
    source: ReturnType<typeof documentScope>,
    mode: string,
    text: string,
  ) {
    const update = words(true);
    return {
      ...update,
      ...source,
      mode,
      words: update.words.map((w) => {
        const { wordId, captionId, provisional, ...legacy } = w;
        return {
          ...(mode === 'streaming' ? w : legacy),
          w: text,
          sourceId: source.sourceId,
        };
      }),
    };
  }

  it.each(['windowed', 'streaming'])(
    'isolates fresh-document replay and overlapping captions in %s mode',
    async (mode) => {
      process.env.CAPTION_MODE = mode;
      const a = documentScope('session-A', mediaA);
      const b = documentScope('session-B', mediaB);
      const first = client();
      gateway.handleConnection(first.c);
      first.send({ ...a, type: 'source-switch' });
      receive(JSON.stringify(sourceWords(a, mode, 'OLD_VIDEO_A')));
      await jest.runOnlyPendingTimersAsync();
      expect(translateBatch).toHaveBeenCalledTimes(1);

      const second = client();
      gateway.handleConnection(second.c);
      second.send({ ...b, type: 'source-switch' });
      // Offscreen gửi seek ngay khi mở WS, trước cả audio mới.
      second.send({ ...b, type: 'seek', seekTimeAtCapture: 0 });
      expect(second.sent.at(-1)).toMatchObject({
        ...b,
        words: [],
        translations: [],
        captions: [],
      });
      receive(JSON.stringify(sourceWords(b, mode, 'NEW_VIDEO_B')));
      await jest.runOnlyPendingTimersAsync();
      const live = second.sent.find((m) => m.type === 'words');
      expect(live.words.map((w: any) => w.w)).toEqual(['NEW_VIDEO_B']);
      if (mode === 'streaming') {
        expect(live.removedWordIds).toEqual([]);
        expect(live.removedCaptionIds).toEqual([]);
        expect(transcript.getFinalizedCaptions(b.sourceId)).toHaveLength(1);
      }
      second.send({ ...b, generation: 2, type: 'seek', seekTimeAtCapture: 0 });
      expect(second.sent.at(-1).words.map((w: any) => w.w)).toEqual([
        'NEW_VIDEO_B',
      ]);
      expect(second.sent.at(-1).translations[0].text).toBe('NEW_VIDEO_B');
      expect(transcript.getRangeFrom(a.sourceId, 0)[0].w).toBe('OLD_VIDEO_A');
      expect(translateBatch).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['windowed', 'streaming'])(
    'keeps late A translation out of B replay in %s mode',
    async (mode) => {
      process.env.CAPTION_MODE = mode;
      let finish!: (value: any) => void;
      translateBatch.mockImplementation(
        () => new Promise((resolve) => (finish = resolve)),
      );
      const a = documentScope('session-A', mediaA);
      const b = documentScope('session-B', mediaB);
      const first = client();
      gateway.handleConnection(first.c);
      first.send({ ...a, type: 'source-switch' });
      receive(JSON.stringify(sourceWords(a, mode, 'OLD_VIDEO_A')));
      await jest.advanceTimersByTimeAsync(1);
      const second = client();
      gateway.handleConnection(second.c);
      second.send({ ...b, type: 'source-switch' });
      finish([{ text: 'VI_A' }]);
      await Promise.resolve();
      await Promise.resolve();
      second.send({ ...b, type: 'seek', seekTimeAtCapture: 0 });
      expect(second.sent.at(-1)).toMatchObject({
        words: [],
        translations: [],
        captions: [],
      });
      expect(transcript.getTranslationsFrom(a.sourceId, 0)[0].vi).toBe('VI_A');
      expect(second.sent.filter((m) => m.type === 'translation')).toEqual([]);
    },
  );

  it.each(['windowed', 'streaming'])(
    'retains same-source replay across generations and capture reconnect in %s mode',
    async (mode) => {
      process.env.CAPTION_MODE = mode;
      const a = documentScope('session-A', mediaA);
      const first = client();
      gateway.handleConnection(first.c);
      first.send({ ...a, type: 'source-switch' });
      receive(JSON.stringify(sourceWords(a, mode, 'VIDEO_A')));
      await jest.runOnlyPendingTimersAsync();
      first.send({ ...a, generation: 2, type: 'seek', seekTimeAtCapture: 0 });
      expect(first.sent.at(-1).words[0].w).toBe('VIDEO_A');
      expect(first.sent.at(-1).translations[0].text).toBe('VIDEO_A');
      const second = client();
      gateway.handleConnection(second.c);
      const reconnected = { ...a, sessionId: 'reconnected' };
      second.send({ ...reconnected, type: 'source-switch' });
      second.send({ ...reconnected, type: 'seek', seekTimeAtCapture: 0 });
      expect(second.sent.at(-1)).toMatchObject({
        ...reconnected,
        words: [{ w: 'VIDEO_A' }],
        translations: [{ text: 'VIDEO_A' }],
      });
      receive(JSON.stringify(sourceWords(reconnected, mode, 'VIDEO_A')));
      await jest.runOnlyPendingTimersAsync();
      expect(translateBatch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['windowed', 'streaming'])(
    'replays each original source after A to B to A selection in %s mode',
    async (mode) => {
      process.env.CAPTION_MODE = mode;
      const sources = new SourceIdentity();
      const page = 'https://example.test/watch';
      const a = {
        ...scope,
        sourceId: sources.forVideo({ currentSrc: mediaA, src: '' }, page),
      };
      const b = {
        ...scope,
        generation: 2,
        sourceId: sources.forVideo({ currentSrc: mediaB, src: '' }, page),
      };
      const c = client();
      gateway.handleConnection(c.c);
      c.send({ ...a, type: 'source-switch' });
      receive(JSON.stringify(sourceWords(a, mode, 'VIDEO_A')));
      await jest.runOnlyPendingTimersAsync();
      c.send({ ...b, type: 'source-switch' });
      receive(JSON.stringify(sourceWords(b, mode, 'VIDEO_B')));
      await jest.runOnlyPendingTimersAsync();
      c.send({ ...b, type: 'seek', seekTimeAtCapture: 0 });
      expect(c.sent.at(-1)).toMatchObject({
        ...b,
        words: [{ w: 'VIDEO_B' }],
        translations: [{ text: 'VIDEO_B' }],
      });
      const returned = { ...a, generation: 3 };
      c.send({ ...returned, type: 'source-switch' });
      c.send({ ...returned, type: 'seek', seekTimeAtCapture: 0 });
      expect(c.sent.at(-1)).toMatchObject({
        ...returned,
        words: [{ w: 'VIDEO_A' }],
        translations: [{ text: 'VIDEO_A' }],
      });
      expect(translateBatch).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['windowed', 'streaming'])(
    'rejects stale snapshot restores and sidecar results after replacement in %s mode',
    async (mode) => {
      process.env.CAPTION_MODE = mode;
      const a = documentScope('session-A', mediaA);
      const b = documentScope('session-B', mediaB);
      const first = client();
      gateway.handleConnection(first.c);
      first.send({ ...a, type: 'source-switch' });
      const second = client();
      gateway.handleConnection(second.c);
      second.send({ ...b, type: 'source-switch' });
      const stale = sourceWords(a, mode, 'STALE_VIDEO_A');
      const restore = {
        type: 'restore-snapshot',
        words: stale.words,
        translations: [{ captionStart: 10, text: 'STALE_VIDEO_A', vi: 'VI_A' }],
      };
      first.send({ ...restore, ...a });
      second.send({ ...restore, ...a });
      second.send({ ...b, generation: 2, type: 'seek', seekTimeAtCapture: 0 });
      second.send({ ...restore, ...b });
      receive(JSON.stringify(stale));
      receive(JSON.stringify(sourceWords(b, mode, 'STALE_GENERATION_B')));
      await jest.runOnlyPendingTimersAsync();
      expect(second.sent.filter((m) => m.type === 'words')).toEqual([]);
      second.send({ ...b, generation: 2, type: 'seek', seekTimeAtCapture: 0 });
      expect(second.sent.at(-1)).toMatchObject({
        words: [],
        translations: [],
        captions: [],
      });
      expect(transcript.getRangeFrom(a.sourceId, 0)).toEqual([]);
      expect(translateBatch).not.toHaveBeenCalled();
    },
  );

  it.each(['windowed', 'streaming'])(
    'restores a stable URL into a new document scope without leaking to a different URL in %s mode',
    async (mode) => {
      process.env.CAPTION_MODE = mode;
      jest.useRealTimers();
      let storage: Record<string, unknown> = {};
      const store = new SnapshotStore({
        get: async () => structuredClone(storage),
        set: async (items) => {
          storage = structuredClone(items);
        },
      });
      const a = documentScope('session-A', mediaA);
      await store.save(mediaA, {
        version: 1,
        savedAt: Date.now(),
        words: sourceWords(a, mode, 'VIDEO_A').words,
        translations: [
          {
            sourceId: a.sourceId,
            ...(mode === 'streaming' ? { captionId: 'c1' } : {}),
            captionStart: 10,
            text: 'VIDEO_A',
            vi: 'VI_A',
          },
        ],
      });
      expect(await store.load(mediaB)).toBeNull();
      const restored = (await store.load(mediaA))!;
      const refreshed = documentScope('session-refreshed', mediaA);
      expect(refreshed.sourceId).not.toBe(a.sourceId);
      const c = client();
      gateway.handleConnection(c.c);
      c.send({ ...refreshed, type: 'source-switch' });
      c.send({ ...refreshed, type: 'seek', seekTimeAtCapture: 0 });
      expect(c.sent.at(-1).words).toEqual([]);
      c.send({
        ...refreshed,
        type: 'restore-snapshot',
        words: restored.words,
        translations: restored.translations,
      });
      expect(c.sent.at(-1)).toMatchObject({
        ...refreshed,
        words: [{ w: 'VIDEO_A', sourceId: refreshed.sourceId }],
        translations: [{ vi: 'VI_A', sourceId: refreshed.sourceId }],
      });
      expect(translateBatch).not.toHaveBeenCalled();
    },
  );

  it('rejects provisional restore and restores finalized data without translation requests', async () => {
    const c = client();
    gateway.handleConnection(c.c);
    c.send({ ...scope, type: 'source-switch' });
    c.send({
      ...scope,
      type: 'restore-snapshot',
      words: words().words,
      translations: [],
    });
    expect(c.sent).toEqual([]);
    c.send({
      ...scope,
      type: 'restore-snapshot',
      words: words(true).words,
      translations: [
        { captionId: 'c1', captionStart: 10, text: 'hello', vi: 'xin chao' },
      ],
    });
    await jest.runOnlyPendingTimersAsync();
    expect(c.sent[0].type).toBe('replay');
    expect(translateBatch).not.toHaveBeenCalled();
    expect(c.sent[0].translations).toHaveLength(1);
  });
  it('rejects old socket messages and stale results after generation change', () => {
    const c = client();
    gateway.handleConnection(c.c);
    c.send({ ...scope, type: 'source-switch' });
    c.send({ ...scope, generation: 2, type: 'seek', seekTimeAtCapture: 10 });
    receive(JSON.stringify(words()));
    expect(c.sent.filter((m) => m.type === 'words')).toEqual([]);
    const replacement = client();
    gateway.handleConnection(replacement.c);
    c.send({ ...scope, type: 'source-switch' });
    expect(sidecar.sendControl).toHaveBeenCalledTimes(2);
    gateway.handleDisconnect(c.c);
    replacement.send({ ...scope, generation: 3, type: 'source-switch' });
    expect(sidecar.sendControl).toHaveBeenCalledTimes(3);
  });
});
