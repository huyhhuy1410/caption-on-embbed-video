import { AudioGateway } from './audio.gateway';
import { SidecarService } from './sidecar/sidecar.service';
import { TranscriptService, Word } from './transcript/transcript.service';
import { VideoClockService } from './clock/video-clock.service';
import { TranslateService } from '../ai/translate.service';
import { TranslationRateLimiter } from '../ai/translation-rate-limiter.service';
import { ProviderUnavailableError } from '../ai/errors';

const scope = { sessionId: 'session', generation: 1, sourceId: 'v1' };
function word(w: string): Word {
  return { w, s: 0, e: 0.5, videoStart: 1, videoEnd: 1.5, captionStart: 1, c: 1, sourceId: 'v1' };
}
function fixture() {
  let receive: (data: Buffer) => void;
  const sidecar = { setMessageHandler: (handler: typeof receive) => { receive = handler; },
    setOpenHandler: jest.fn(), sendControl: jest.fn() };
  const transcript = new TranscriptService();
  const translate = jest.fn().mockResolvedValue([]);
  const gateway = new AudioGateway(sidecar as unknown as SidecarService, transcript,
    new VideoClockService(), { translateBatch: translate } as unknown as TranslateService, new TranslationRateLimiter());
  const messages: Record<string, any>[] = [];
  const handlers = new Map<string, (data: Buffer, binary: boolean) => void>();
  const client = { readyState: 1, on: (event: string, handler: any) => handlers.set(event, handler),
    send: (payload: string) => messages.push(JSON.parse(payload)) };
  gateway.handleConnection(client as never);
  const control = (payload: object) => handlers.get('message')!(Buffer.from(JSON.stringify(payload)), false);
  control({ type: 'source-switch', ...scope });
  return { transcript, translate, messages, control,
    words: (text: string, generation = 1) => receive!(Buffer.from(JSON.stringify({ type: 'words', ...scope, generation, words: [word(text)] }))) };
}

describe('windowed gateway', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it('sends the canonical patch once, rejects stale generations, and scopes translations', async () => {
    const f = fixture();
    f.translate.mockResolvedValue([{ text: 'VI' }]);
    f.words('hello');
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0]).toMatchObject({ mode: 'windowed', replaceRanges: [{ from: 1, to: 1.5 }] });
    expect(f.messages[0].words[0].windowedGroupId).toEqual(expect.any(String));
    f.words('stale', 0);
    expect(f.messages).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(f.messages[1]).toMatchObject({ type: 'translation', ...scope, text: 'hello', vi: 'VI',
      windowedGroupId: f.messages[0].words[0].windowedGroupId });
    f.control({ type: 'seek', ...scope, generation: 2, seekTimeAtCapture: 1.2 });
    const replay = f.messages.at(-1)!;
    expect(replay.words).toEqual(f.messages[0].words);
    expect(replay.translations[0].vi).toBe('VI');
  });

  it('never caches or delivers a deferred translation after its group is replaced', async () => {
    const f = fixture();
    let resolve!: (value: { text: string }[]) => void;
    f.translate.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    f.words('old');
    const oldId = f.messages[0].words[0].windowedGroupId;
    await jest.advanceTimersByTimeAsync(1);
    f.words('new');
    resolve([{ text: 'stale VI' }]);
    await jest.advanceTimersByTimeAsync(1);
    expect(f.transcript.getTranslation('v1', oldId)).toBeUndefined();
    expect(f.messages.some(m => m.type === 'translation' && m.text === 'old')).toBe(false);
  });

  it('does not retry a replaced group after a deferred provider overload', async () => {
    const f = fixture();
    let reject!: (error: Error) => void;
    f.translate.mockImplementationOnce(() => new Promise((_resolve, r) => { reject = r; }));
    f.words('old');
    await jest.advanceTimersByTimeAsync(1);
    f.words('new');
    reject(new ProviderUnavailableError('503', 1000, true));
    await jest.advanceTimersByTimeAsync(1001);
    expect(f.translate.mock.calls.map(call => call[0])).toEqual([['old'], ['new']]);
  });
});
