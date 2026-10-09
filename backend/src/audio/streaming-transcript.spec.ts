import { TranscriptService } from './transcript/transcript.service';
import {
  CaptureScope,
  WordsUpdate,
  StreamingWord,
} from './streaming-transcript';
const scope: CaptureScope = { sessionId: 's1', generation: 1, sourceId: 'v1' };
function word(
  id = 'w1',
  captionId = 'c1',
  overrides: Partial<StreamingWord> = {},
): StreamingWord {
  return {
    wordId: id,
    captionId,
    w: 'hello',
    s: 0,
    e: 1,
    videoStart: 10,
    videoEnd: 11,
    captionStart: 10,
    c: 0.9,
    provisional: true,
    sourceId: 'v1',
    ...overrides,
  };
}
function update(
  revision: number,
  words = [word()],
  finalized = false,
  overrides: Partial<WordsUpdate> = {},
): WordsUpdate {
  return {
    ...scope,
    type: 'words',
    mode: 'streaming',
    revision,
    words,
    captions: [
      {
        captionId: words[0]?.captionId ?? 'c1',
        captionStart: words[0]?.captionStart ?? 10,
        wordIds: words.map((w) => w.wordId!),
        finalized,
      },
    ],
    removedCaptionIds: [],
    removedWordIds: [],
    ...overrides,
  };
}
describe('streaming transcript', () => {
  let service: TranscriptService;
  beforeEach(() => {
    service = new TranscriptService();
    service.setScope(scope);
  });
  it('upserts moving words and removes suffix atomically without legacy text dedup', () => {
    expect(
      service.applyStreamingUpdate(
        update(1, [word(), word('w2', 'c1', { videoStart: 10.1 })]),
      ),
    ).not.toBeNull();
    expect(
      service.applyStreamingUpdate(
        update(
          2,
          [word('w1', 'c1', { w: 'changed', videoStart: 10.7 })],
          false,
          { removedWordIds: ['w2'] },
        ),
      ),
    ).not.toBeNull();
    expect(service.getRangeFrom('v1', 0)).toEqual([]);
    const result = service.applyStreamingUpdate(
      update(
        3,
        [
          word('w1', 'c1', {
            w: 'changed',
            videoStart: 10.7,
            provisional: false,
          }),
        ],
        true,
      ),
    );
    expect(result?.finalized[0].words).toHaveLength(1);
    expect(service.getRangeFrom('v1', 0)[0].w).toBe('changed');
  });
  it('rejects stale scope/revision and broken membership without advancing revision', () => {
    expect(service.applyStreamingUpdate(update(1))).not.toBeNull();
    expect(
      service.applyStreamingUpdate(
        update(2, [], false, { removedWordIds: ['w1'], captions: [] }),
      ),
    ).toBeNull();
    expect(
      service.applyStreamingUpdate(
        update(2, [word('w1', 'c1', { w: 'fixed' })]),
      ),
    ).not.toBeNull();
    expect(service.applyStreamingUpdate(update(2))).toBeNull();
    expect(
      service.applyStreamingUpdate(
        update(3, [word()], false, { generation: 0 }),
      ),
    ).toBeNull();
    expect(
      service.applyStreamingUpdate(
        update(3, [word()], false, { sourceId: 'v2' }),
      ),
    ).toBeNull();
  });
  it('keeps finalized membership/text immutable and preserves repeated words', () => {
    const words = [
      word('w1', 'c1', { provisional: false }),
      word('w2', 'c1', { provisional: false, videoStart: 10.1 }),
    ];
    expect(
      service.applyStreamingUpdate(update(1, words, true))?.finalized,
    ).toHaveLength(1);
    expect(service.getRangeFrom('v1', 0)).toHaveLength(2);
    expect(
      service.applyStreamingUpdate(
        update(
          2,
          [word('w1', 'c1', { w: 'mutated', provisional: false })],
          true,
        ),
      ),
    ).toBeNull();
    expect(
      service.applyStreamingUpdate(
        update(2, [], false, { captions: [], removedCaptionIds: ['c1'] }),
      ),
    ).toBeNull();
  });
  it('reconciles regenerated IDs against finalized history and does not enqueue translation again', () => {
    service.applyStreamingUpdate(
      update(1, [word('w1', 'c1', { provisional: false })], true),
    );
    service.setTranslation({
      sourceId: 'v1',
      captionId: 'c1',
      captionStart: 10,
      text: 'hello',
      vi: 'xin chao',
    });
    service.setScope({ ...scope, generation: 2 });
    const regenerated = service.applyStreamingUpdate(
      update(
        1,
        [
          word('new-w', 'new-c', {
            videoStart: 10.2,
            videoEnd: 11.2,
            captionStart: 10.2,
            provisional: false,
          }),
        ],
        true,
        { generation: 2 },
      ),
    );
    expect(regenerated?.finalized).toEqual([]);
    expect(regenerated?.update.removedCaptionIds).toContain('new-c');
    expect(regenerated?.update.words.map((w) => w.wordId)).toEqual(['w1']);
    expect(service.getRangeFrom('v1', 10.5).map((w) => w.wordId)).toEqual([
      'w1',
    ]);
    expect(service.getTranslationsFrom('v1', 10.5)[0].captionId).toBe('c1');
    expect(service.getRangeFrom('v2', 0)).toEqual([]);
  });
  it('reconciles moved timestamps over half a second and subsequent suffix revisions', () => {
    service.applyStreamingUpdate(
      update(1, [word('w1', 'c1', { provisional: false })], true),
    );
    service.setScope({ ...scope, generation: 2 });
    const moved = word('new-w', 'new-c', {
      videoStart: 10.8,
      videoEnd: 11.8,
      captionStart: 10.8,
    });
    const first = service.applyStreamingUpdate(
      update(1, [moved], false, { generation: 2 }),
    );
    expect(first?.update.words.map((w) => w.wordId)).toEqual(['w1']);
    const revision = service.applyStreamingUpdate(
      update(2, [{ ...moved, w: 'changed' }], false, {
        generation: 2,
        captions: [],
      }),
    );
    expect(revision?.update.words.map((w) => w.wordId)).toEqual(['w1']);
    expect(revision?.update.removedWordIds).toContain('new-w');
    const final = service.applyStreamingUpdate(
      update(3, [{ ...moved, w: 'changed', provisional: false }], true, {
        generation: 2,
      }),
    );
    expect(final?.finalized).toEqual([]);
    expect(service.getRangeFrom('v1', 0)).toHaveLength(1);
  });

  it('handles finalized caption-only transitions after local-agreement words were already frozen', () => {
    service.applyStreamingUpdate(
      update(1, [word('w1', 'c1', { provisional: false })], false),
    );
    const finalized = service.applyStreamingUpdate(
      update(2, [], true, {
        captions: [
          {
            captionId: 'c1',
            captionStart: 10,
            wordIds: ['w1'],
            finalized: true,
          },
        ],
      }),
    );
    expect(finalized?.finalized).toHaveLength(1);
    expect(service.getRangeFrom('v1', 0)).toHaveLength(1);
  });

  it('keeps genuine repeated captions in the current generation distinct', () => {
    service.applyStreamingUpdate(
      update(1, [word('w1', 'c1', { provisional: false })], true),
    );
    const repeated = word('w2', 'c2', {
      videoStart: 11.1,
      videoEnd: 12.1,
      captionStart: 11.1,
      provisional: false,
    });
    expect(
      service.applyStreamingUpdate(update(2, [repeated], true))?.finalized,
    ).toHaveLength(1);
    expect(service.getFinalizedCaptions('v1')).toHaveLength(2);
  });

  it('restores finalized snapshots with active source remapping and reconciles existing translations', () => {
    const saved = word('saved-w', 'saved-c', {
      sourceId: 'old-source',
      provisional: false,
    });
    expect(
      service.restoreSnapshot(
        scope,
        [saved],
        [
          {
            captionStart: 10,
            captionId: 'saved-c',
            text: 'hello',
            vi: 'xin chao',
          },
        ],
      ),
    ).toBe(true);
    expect(service.getRangeFrom('v1', 0)[0].sourceId).toBe('v1');
    expect(service.getTranslation('v1', 'saved-c')?.vi).toBe('xin chao');
    expect(
      service.restoreSnapshot(
        scope,
        [word('new', 'c-new', { provisional: false })],
        [
          {
            captionStart: 10,
            captionId: 'c-new',
            text: 'hello',
            vi: 'replace',
          },
        ],
      ),
    ).toBe(true);
    expect(service.getRangeFrom('v1', 0)).toHaveLength(1);
    expect(service.getTranslation('v1', 'saved-c')?.vi).toBe('xin chao');
    expect(service.restoreSnapshot(scope, [word()], [])).toBe(false);
    expect(
      service.restoreSnapshot(
        scope,
        [saved],
        [{ captionStart: NaN, text: 'x', vi: 'x' }],
      ),
    ).toBe(false);
  });
  it('bounds finalized history and expires translations on direct cache lookup', () => {
    jest.useFakeTimers();
    try {
      for (let i = 0; i < 310; i++) {
        const w = word(`w${i}`, `c${i}`, {
          videoStart: i * 2,
          videoEnd: i * 2 + 1,
          captionStart: i * 2,
          provisional: false,
        });
        expect(
          service.applyStreamingUpdate(update(i + 1, [w], true)),
        ).not.toBeNull();
      }
      expect(service.getFinalizedCaptions('v1')).toHaveLength(300);
      service.setTranslation({
        sourceId: 'v1',
        captionId: 'c',
        captionStart: 0,
        text: 'hello',
        vi: 'x',
      });
      jest.advanceTimersByTime(30 * 60_000 + 1);
      expect(service.getTranslation('v1', 'c')).toBeUndefined();
      expect(service.getRangeFrom('v1', 0)).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });
});
