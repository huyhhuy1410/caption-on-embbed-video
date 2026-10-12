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

  it('reuses full-text translation after timing and confidence jitter', () => {
    const service = new TranscriptService();
    const initial = service.addWords([word('we', 1), word('leave', 1.3)]);
    const oldId = initial.words[0].windowedGroupId!;
    const translation = { windowedGroupId: oldId, captionStart: 1,
      text: 'we leave', vi: 'chúng ta đi', sourceId: 'v1' };
    service.setTranslation(translation);
    const revised = service.addWords([
      { ...word('we', 1.07, 1.07), c: 0.8 },
      { ...word('leave', 1.37, 1.07), c: 0.7 },
    ]);
    const newId = revised.words[0].windowedGroupId!;
    expect(newId).not.toBe(oldId);
    expect(service.getTranslation('v1', oldId)).toBeUndefined();
    expect(service.getTranslation('v1', newId)).toEqual({ ...translation,
      windowedGroupId: newId, captionStart: 1.07 });
    expect(translation.windowedGroupId).toBe(oldId);
    expect(service.getTranslationsFrom('v1', 0)).toEqual([
      expect.objectContaining({ windowedGroupId: newId, vi: 'chúng ta đi' }),
    ]);
    expect(applyPatch(initial.words, revised, () => 'unexpected'))
      .toEqual(service.getWindowedReplay('v1', 0).words);
  });

  it('restores translation when the original hypothesis returns after a changed sentence', () => {
    const service = new TranscriptService();
    const input = [word('we', 1), word('leave', 1.3)];
    const oldId = service.addWords(input).words[0].windowedGroupId!;
    service.setTranslation({ windowedGroupId: oldId, captionStart: 1,
      text: 'we leave', vi: 'chúng ta đi', sourceId: 'v1' });
    const changed = service.addWords([word('you', 1), word('stay', 1.3)]);
    expect(service.getTranslation('v1', oldId)).toBeUndefined();
    expect(service.getTranslationsFrom('v1', 0)).toEqual([]);
    expect(service.getTranslation('v1', changed.words[0].windowedGroupId!)).toBeUndefined();
    for (let i = 0; i < 3; i++) {
      const returned = service.addWords(input.map(w => ({ ...w, c: 0.8 - i * 0.1 })));
      expect(service.getTranslation('v1', returned.words[0].windowedGroupId!))
        .toMatchObject({ text: 'we leave', vi: 'chúng ta đi' });
      service.addWords([word('you', 1), word('stay', 1.3)]);
    }
  });

  it.each(['there?', 'else!'])('does not reuse translation for changed text %s', text => {
    const service = new TranscriptService();
    const oldId = service.addWords([word('Hello', 1), word('there!', 1.3)]).words[0].windowedGroupId!;
    service.setTranslation({ windowedGroupId: oldId, captionStart: 1,
      text: 'Hello there!', vi: 'xin chào', sourceId: 'v1' });
    const patch = service.addWords([word('Hello', 1.02, 1.02), word(text, 1.32, 1.02)]);
    expect(service.getTranslation('v1', oldId)).toBeUndefined();
    expect(service.getTranslation('v1', patch.words[0].windowedGroupId!)).toBeUndefined();
  });

  it('does not reuse a full translation for a fragment or stale cached text', () => {
    const service = new TranscriptService();
    const oldId = service.addWords([word('we', 1), word('saw', 1.3), word('it', 1.6)]).words[0].windowedGroupId!;
    service.setTranslation({ windowedGroupId: oldId, captionStart: 1,
      text: 'we saw it', vi: 'chúng tôi thấy nó', sourceId: 'v1' });
    const patch = service.addWords([word('saw', 1.3, 1.3), word('it', 1.6, 1.3)]);
    expect(service.getTranslation('v1', oldId)).toBeUndefined();
    for (const group of groupWords(patch.words).keys())
      expect(service.getTranslation('v1', group)).toBeUndefined();
    const fragmentId = patch.words.find(w => w.w === 'saw')!.windowedGroupId!;
    service.setTranslation({ windowedGroupId: fragmentId, captionStart: 1.3,
      text: 'wrong text', vi: 'stale', sourceId: 'v1' });
    const jitter = service.addWords([word('saw', 1.34, 1.34), word('it', 1.64, 1.34)]);
    expect(service.getTranslation('v1', jitter.words[0].windowedGroupId!)).toBeUndefined();
  });

  it('matches repeated occurrences by time, not global text', () => {
    const service = new TranscriptService();
    const initial = service.addWords([word('echo', 1, 1), word('echo', 10, 10)]);
    initial.words.forEach((w, i) => service.setTranslation({ windowedGroupId: w.windowedGroupId,
      captionStart: w.captionStart, text: 'echo', vi: `occurrence-${i}`, sourceId: 'v1' }));
    const unrelated = service.addWords([word('echo', 20, 20)]);
    expect(service.getTranslation('v1', unrelated.words[0].windowedGroupId!)).toBeUndefined();
    const otherSource = service.addWords([{ ...word('echo', 1.04, 1.04), sourceId: 'v2' }]);
    expect(service.getTranslation('v2', otherSource.words[0].windowedGroupId!)).toBeUndefined();
    const revised = service.addWords([word('echo', 1.04, 1.04), word('echo', 10.04, 10.04)]);
    expect(revised.words.map(w => service.getTranslation('v1', w.windowedGroupId!)?.vi))
      .toEqual(['occurrence-0', 'occurrence-1']);
  });

  it('rejects one old occurrence matching multiple new occurrences', () => {
    const service = new TranscriptService();
    const oldId = service.addWords([word('echo', 1), word('now', 5)]).words[0].windowedGroupId!;
    service.setTranslation({ windowedGroupId: oldId, captionStart: 1,
      text: 'echo now', vi: 'old', sourceId: 'v1' });
    const patch = service.addWords([
      word('echo', 1.1, 1.1), word('now', 1.4, 1.1),
      word('echo', 4.5, 4.5), word('now', 4.8, 4.5),
    ]);
    expect(service.getTranslation('v1', oldId)).toBeUndefined();
    for (const id of groupWords(patch.words).keys())
      expect(service.getTranslation('v1', id)).toBeUndefined();
  });

  it('counts untranslated old occurrences when deciding ambiguity', () => {
    const service = new TranscriptService();
    const initial = service.addWords([
      { ...word('echo', 1, 1), videoEnd: 3 },
      { ...word('echo', 2, 2), videoEnd: 4 },
    ]);
    service.setTranslation({ windowedGroupId: initial.words[0].windowedGroupId,
      captionStart: 1, text: 'echo', vi: 'ambiguous', sourceId: 'v1' });
    const patch = service.addWords([{ ...word('echo', 1.5, 1.5), videoEnd: 3.5 }]);
    expect(service.getTranslation('v1', patch.words[0].windowedGroupId!)).toBeUndefined();
  });

  it('does not transfer expired translations', () => {
    const service = new TranscriptService();
    const oldId = service.addWords([word('echo', 1)]).words[0].windowedGroupId!;
    service.setTranslation({ windowedGroupId: oldId, captionStart: 1,
      text: 'echo', vi: 'expired', sourceId: 'v1' });
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000);
    try {
      const patch = service.addWords([word('echo', 1.04, 1.04)]);
      expect(service.getTranslation('v1', patch.words[0].windowedGroupId!)).toBeUndefined();
    } finally { clock.mockRestore(); }
  });

  it('does not share canonical state between sources', () => {
    const service = new TranscriptService();
    service.addWords([word('one', 1)]);
    service.addWords([{ ...word('two', 1), sourceId: 'v2' }]);
    expect(service.getWindowedReplay('v1', 0).words.map(w => w.w)).toEqual(['one']);
  });
});
