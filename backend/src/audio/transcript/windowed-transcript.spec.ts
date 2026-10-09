import { TranscriptService, Word } from './transcript.service';
import { applyPatch, groupWords } from './windowed-transcript';

function word(w: string, start: number, captionStart = 1): Word {
  return { w, s: start, e: start + 0.2, videoStart: start, videoEnd: start + 0.2, captionStart, c: 0.9, sourceId: 'v1' };
}
const scope = { sessionId: 'session', generation: 1, sourceId: 'v1' };

describe('canonical windowed transcript', () => {
  it('keeps spoken repetitions and reuses immutable identities for duplicate delivery', () => {
    const service = new TranscriptService();
    const input = [word('no', 1), word('no', 1.3), word('again', 1.6), word('again', 1.9)];
    const first = service.addWords(input);
    const second = service.addWords(input);
    expect(second.words).toEqual(first.words);
    expect(service.getRangeFrom('v1', 0).map(w => w.w)).toEqual(['no', 'no', 'again', 'again']);
    expect(service.getWindowedReplay('v1', 1.7).words).toEqual(first.words);
    expect(service.restoreSnapshot(scope, first.words, [])).toBe(true);
    expect(service.getWindowedReplay('v1', 0).words).toEqual(first.words);
  });

  it('splits both sides of an interior replacement and retires the old translation', () => {
    const service = new TranscriptService();
    const initial = service.addWords([word('left', 1), word('middle', 3), word('right', 5)]);
    const oldId = initial.words[0].windowedGroupId!;
    service.setTranslation({ windowedGroupId: oldId, captionStart: 1, text: 'left middle right', vi: 'old', sourceId: 'v1' });
    const patch = service.addWords([word('new', 3, 3)]);
    const history = applyPatch(initial.words, patch, () => 'unexpected-local-fragment');
    expect(history.map(w => w.w)).toEqual(['left', 'new', 'right']);
    expect(new Set(history.map(w => w.windowedGroupId)).size).toBe(3);
    expect(history).toEqual(service.getWindowedReplay('v1', 0).words);
    expect(service.getTranslation('v1', oldId)).toBeUndefined();
    expect(service.isCurrentWindowedGroup('v1', oldId, 'left middle right')).toBe(false);
    expect(applyPatch(history, patch, () => 'unexpected')).toEqual(history);
  });

  it('replaces the recorded shifted Why windows without dropping matching words', () => {
    const service = new TranscriptService();
    const old = service.addWords(['Why', 'did', 'I', 'say', '-'].map((text, i) => word(text, 10.56 + i * 0.2, 10.56)));
    const revised = ['Why', 'did', 'I', 'say', 'it', 'so', 'early?'].map((text, i) => word(text, 10.42 + i * 0.2, 10.42));
    const patch = service.addWords(revised);
    const history = applyPatch(old.words, patch, () => 'unexpected');
    expect(history.map(w => w.w)).toEqual(revised.map(w => w.w));
    expect(groupWords(history).size).toBe(1);
  });

  it('does not grant authority across sparse replay or snapshot gaps', () => {
    const service = new TranscriptService();
    service.addWords([word('first', 1)]);
    service.addWords([word('last', 20, 20)]);
    const replay = service.getWindowedReplay('v1', 0);
    const middle = { ...word('middle', 10, 10), windowedGroupId: 'local-middle' };
    expect(applyPatch([middle], replay, () => 'unexpected').map(w => w.w)).toEqual(['first', 'middle', 'last']);
    service.restoreSnapshot(scope, [word('snapshot', 10, 10), word('stale', 1)], []);
    expect(service.getRangeFrom('v1', 0).map(w => w.w)).toEqual(['first', 'snapshot', 'last']);
  });

  it('retains covered silence against lower-priority snapshot imports', () => {
    const service = new TranscriptService();
    service.addWords([word('left', 1), word('right', 5)]);
    service.restoreSnapshot(scope, [word('stale-in-silence', 3, 3)], []);
    expect(service.getRangeFrom('v1', 0).map(w => w.w)).toEqual(['left', 'right']);
  });

  it('preserves zero-duration tokens once and leaves touching boundaries intact', () => {
    const service = new TranscriptService();
    const marker = { ...word('-', 2, 2), videoEnd: 2 };
    const first = service.addWords([marker]);
    expect(service.addWords([marker]).words).toEqual(first.words);
    service.addWords([word('after', 2.1, 2.1)]);
    expect(service.getRangeFrom('v1', 0).map(w => w.w)).toEqual(['-', 'after']);
  });

  it('does not share canonical state between sources', () => {
    const service = new TranscriptService();
    service.addWords([word('one', 1)]);
    service.addWords([{ ...word('two', 1), sourceId: 'v2' }]);
    expect(service.getWindowedReplay('v1', 0).words.map(w => w.w)).toEqual(['one']);
  });
});
