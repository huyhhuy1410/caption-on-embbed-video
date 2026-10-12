import { Test, TestingModule } from '@nestjs/testing';
import { TranscriptService, Word } from './transcript.service';
// Fake word with a given videoStart.
function makeWord(videoStart: number, sourceId: string | null = null): Word {
  return {
    w: 'test',
    s: 0,
    e: 0.5,
    videoStart,
    videoEnd: videoStart + 0.5,
    captionStart: videoStart,
    c: 1,
    sourceId,
  };
}
describe('TranscriptService', () => {
  let service: TranscriptService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TranscriptService],
    }).compile();
    service = module.get<TranscriptService>(TranscriptService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
  it('keeps captionStart when replaying cached words', () => {
    const word = makeWord(4.2);
    word.captionStart = 4.0;

    service.addWords([word]);

    expect(service.getRange(null, 4, 5)).toEqual([
      expect.objectContaining({ captionStart: 4.0 }),
    ]);
  });

  describe('translations', () => {
    it('returns a stored translation for its captionStart', () => {
      service.setTranslation({
        captionStart: 12.0,
        text: 'the model overfits',
        vi: 'mô hình bị quá khớp',
      });

      expect(service.getTranslation(null, 12.0)?.vi).toBe('mô hình bị quá khớp');
      expect(service.getTranslations(null, 11, 13)).toEqual([
        {
          captionStart: 12.0,
          text: 'the model overfits',
          vi: 'mô hình bị quá khớp',
        },
      ]);
    });

    it('getTranslation lets the gateway skip work already done', () => {
      expect(service.getTranslation(null, 4.0)).toBeUndefined();
      service.setTranslation({ captionStart: 4.0, text: 'a', vi: 'b' });
      expect(service.getTranslation(null, 4.0)).toEqual({
        captionStart: 4.0,
        text: 'a',
        vi: 'b',
      });
    });

    it('filters by range and sorts by captionStart', () => {
      service.setTranslation({ captionStart: 30, text: 'c', vi: 'C' });
      service.setTranslation({ captionStart: 10, text: 'a', vi: 'A' });
      service.setTranslation({ captionStart: 20, text: 'b', vi: 'B' });

      // 20 falls outside [21, 31], so only 30 remains.
      expect(service.getTranslations(null, 21, 31)).toEqual([
        { captionStart: 30, text: 'c', vi: 'C' },
      ]);
      // all three, sorted
      expect(service.getTranslations(null, 0, 100).map((t) => t.captionStart)).toEqual(
        [10, 20, 30],
      );
    });

    it('drops a translation past TTL on read', () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      service.setTranslation({ captionStart: 5, text: 'a', vi: 'A' });

      nowSpy.mockReturnValue(1_000_000 + 31 * 60 * 1000);
      expect(service.getTranslations(null, 0, 10)).toEqual([]);
      nowSpy.mockRestore();
    });

    it('evicts the least-recently-used translation when over MAX_BUCKETS', () => {
      let fakeNow = 0;
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => fakeNow);

      for (let i = 0; i < 301; i++) {
        fakeNow = i;
        service.setTranslation({
          captionStart: i,
          text: `t${i}`,
          vi: `v${i}`,
        });
      }

      expect(service.getTranslation(null, 0)).toBeUndefined();
      expect(service.getTranslation(null, 300)).toBeDefined();
      nowSpy.mockRestore();
    });
  });

  // Issue 5.20: videos have independent but overlapping timelines; without a per-source namespace, replaying video B returns video A's lines.
  // Issue 5.25: after a seek, whisper re-decodes the same audio with shifted timestamps (the anchor path changes), and read-time dedup misses it, so the cache bloats and `getRange` returns both timelines mixed.
  describe('re-transcription over an existing range', () => {
    it('replaces the old copy instead of concatenating it', () => {
      // First pass: the old range. Distinct words so read-time dedup keeps them
      // (dedup only drops the same text within 0.5s).
      service.addWords([
        { ...makeWord(50, 'v1'), w: 'one' },
        { ...makeWord(50.4, 'v1'), w: 'two' },
      ]);
      expect(service.getRangeFrom('v1', 0)).toHaveLength(2);

      // Second pass after a seek: same sentence, anchor shifted a few hundred ms,
      // so the new range overlaps the old almost fully (real log shape:
      // `51.72→56.02` then `51.76→56.16`). The old copy must be replaced, not appended.
      service.addWords([
        { ...makeWord(50.3, 'v1'), w: 'one' },
        { ...makeWord(50.8, 'v1'), w: 'two' },
      ]);

      const words = service.getRangeFrom('v1', 0);
      // Only the 2 words of the NEW copy remain, not 4 stitched from both writes.
      expect(words).toHaveLength(2);
      expect(words.map((w) => w.videoStart)).toEqual([50.3, 50.8]);
      // No word from the old copy survives.
      expect(words.some((w) => w.videoStart === 50)).toBe(false);
    });

    it('keeps untouched ranges of the same video', () => {
      service.addWords([makeWord(10, 'v1')]);
      service.addWords([makeWord(50, 'v1')]);
      // Rewrite range 50 over the old copy, shifted far enough that dedup misses it.
      service.addWords([makeWord(50.3, 'v1')]);

      const words = service.getRangeFrom('v1', 0);
      // Range 10 is untouched, so it must survive.
      expect(words.map((w) => w.videoStart)).toEqual([10, 50.3]);
    });

    it('leaves other videos alone', () => {
      service.addWords([makeWord(50, 'v1')]);
      // Another video writing the same range keeps its own copy.
      service.addWords([makeWord(50.3, 'v2')]);

      expect(service.getRangeFrom('v1', 0).map((w) => w.videoStart)).toEqual([50]);
      expect(service.getRangeFrom('v2', 0).map((w) => w.videoStart)).toEqual([
        50.3,
      ]);
    });
  });

  // Issue 5.25: replay only covers 3 seconds, so the rest must wait for the normal cadence.
  describe('getRangeFrom (replay to the end of what was watched)', () => {
    it('returns everything watched past the seek point', () => {
      service.addWords([makeWord(10, 'v1')]);
      service.addWords([makeWord(20, 'v1')]);
      service.addWords([makeWord(30, 'v1')]);
      service.addWords([makeWord(40, 'v1')]);

      // Seek to 20: need 20, 30 and 40 too, not only the 3 seconds after 20.
      expect(service.getRangeFrom('v1', 20).map((w) => w.videoStart)).toEqual([
        20, 30, 40,
      ]);
      // Seek to 0: everything.
      expect(service.getRangeFrom('v1', 0)).toHaveLength(4);
    });

    it('excludes ranges before the seek point', () => {
      service.addWords([makeWord(10, 'v1')]);
      service.addWords([makeWord(30, 'v1')]);

      expect(service.getRangeFrom('v1', 25).map((w) => w.videoStart)).toEqual([
        30,
      ]);
    });

    it('keeps the part of a bucket that STRADDLES the seek point', () => {
      // A bucket is keyed by the FIRST word's second and spans ~one sidecar window,
      // so it can start before the seek point and reach past it. Filtering by
      // `anchorTime` drops everything after the point (Issue 5.35).
      // The older case misses this: seek 25 lands on a bucket boundary, so no bucket
      // straddles the point.
      service.addWords(
        [49, 49.6, 50.2, 50.8, 51.4, 52].map((t) => {
          const word = makeWord(t, 'v1');
          word.w = `w${t}`;
          return word;
        }),
      );

      expect(service.getRangeFrom('v1', 50).map((w) => w.videoStart)).toEqual([
        50.2, 50.8, 51.4, 52,
      ]);
    });

    it('scopes to the source like getRange', () => {
      service.addWords([makeWord(30, 'v1')]);
      service.addWords([makeWord(30, 'v2')]);

      expect(service.getRangeFrom('v2', 0)).toHaveLength(1);
      expect(service.getRangeFrom('v1', 0)).toHaveLength(1);
      expect(service.getRangeFrom('v3', 0)).toEqual([]);
    });
  });

  describe('cache scoped by source', () => {
    it('getRange returns only the requested source', () => {
      service.addWords([makeWord(30, 'video-a')]);
      service.addWords([{ ...makeWord(30, 'video-b'), w: 'other' }]);

      expect(service.getRange('video-a', 29, 31).map((x) => x.w)).toEqual([
        'test',
      ]);
      expect(service.getRange('video-b', 29, 31).map((x) => x.w)).toEqual([
        'other',
      ]);
      // An unknown source gets nothing, not even a bucket on the same second.
      expect(service.getRange('video-c', 29, 31)).toEqual([]);
    });

    it('keeps both videos after switching back', () => {
      service.addWords([makeWord(30, 'video-a')]);
      // Leave video A for B, then return to A — replay must still return A's lines.
      service.addWords([{ ...makeWord(5, 'video-b'), w: 'b-word' }]);
      // Back on A, rewatch the exact same range: the old copy is replaced, not kept.
      service.addWords([{ ...makeWord(30, 'video-a'), w: 'a-again' }]);

      expect(service.getRange('video-a', 29, 31).map((x) => x.w)).toEqual([
        'a-again',
      ]);
      // Video B stays untouched.
      expect(service.getRange('video-b', 4, 6).map((x) => x.w)).toEqual([
        'b-word',
      ]);
    });

    it('getTranslations does not leak across sources', () => {
      service.setTranslation({
        captionStart: 12,
        text: 'a',
        vi: 'A',
        sourceId: 'video-a',
      });
      service.setTranslation({
        captionStart: 12,
        text: 'b',
        vi: 'B',
        sourceId: 'video-b',
      });

      expect(service.getTranslation('video-a', 12)?.vi).toBe('A');
      expect(service.getTranslation('video-b', 12)?.vi).toBe('B');
      expect(service.getTranslations('video-a', 0, 100)).toHaveLength(1);
      expect(service.getTranslations('video-a', 0, 100)[0].vi).toBe('A');
    });

    it('an unknown source is a namespace, not the empty one', () => {
      service.addWords([makeWord(30, null)]);
      // A word with no sourceId (old sidecar) must stay separate from a real video.
      expect(service.getRange(null, 29, 31)).toHaveLength(1);
      expect(service.getRange('video-a', 29, 31)).toEqual([]);
    });
  });

  describe('TTL', () => {
    it('removes a bucket that has not been accessed past TTL', () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      service.addWords([makeWord(0)]);

      nowSpy.mockReturnValue(1_000_000 + 31 * 60 * 1000);
      const result = service.getRange(null, 0, 0.5);
      expect(result).toEqual([]);
      nowSpy.mockRestore();
    });
  });

  describe('LRU', () => {
    it('evicts the least-recently-used bucket when over MAX_BUCKETS', () => {
      let fakeNow = 0;
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => fakeNow);

      for (let i = 0; i < 301; i++) {
        fakeNow = i;
        // 1.5s spacing so the new rule doesn't treat these as re-decoded same words.
        service.addWords([makeWord(i * 1.5)]);
      }
      expect(service.getRange(null, 0, 0.5)).toEqual([]);
      expect(service.getRange(null, 1.5, 2.0)).toHaveLength(1);
      nowSpy.mockRestore();
    });

    it('keeps a recently-touched bucket during eviction', () => {
      let fakeNow = 0;
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => fakeNow);

      service.addWords([makeWord(0)]); // key 0, lastAccess = 0
      fakeNow = 1;
      for (let i = 1; i <= 299; i++) {
        // add 299 buckets (keys 1..299), 1.5s apart so the new rule doesn't see re-decodes.
        fakeNow = i;
        service.addWords([makeWord(i * 1.5)]);
      }
      // now 300 buckets, at the cap (300 = MAX), nothing evicted yet.

      fakeNow = 1_000_000; // jump far ahead
      service.getRange(null, 0, 0.5); // touch key 0 -> lastAccess = 1_000_000 (MOST RECENT)
      fakeNow = 1_000_001;
      service.addWords([makeWord(299 * 1.5 + 1.5)]); // add bucket 301 -> over the cap -> evict
      // lastAccess now: key 0 = 1_000_000, keys 1..299 = 1..299, key 300 = ?
      // key 300 takes the current Date.now(), so two buckets tie at 1_000_000
      // while the rest are older -> evict key 1 (smallest)

      expect(service.getRange(null, 0, 0.5)).toHaveLength(1); // key 0 still alive
      nowSpy.mockRestore();
    });
  });
});
