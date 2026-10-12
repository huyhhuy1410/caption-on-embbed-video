import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { dropClippedHeads, groupWords, intersects, isReplaced, membership, normalizeRuns } from './windowed-transcript';
import type { VideoRange, WindowedPatch } from './windowed-transcript';
import {
  CaptureScope,
  CaptionState,
  FinalCaption,
  StreamingTranscriptStore,
  WordsUpdate,
  captionKey,
  validWord,
} from '../streaming-transcript';
export type Word = {
  w: string;
  s: number;
  e: number;
  videoStart: number;
  videoEnd: number;
  captionStart: number;
  c: number;
  /**
   * Video that produced this word. `videoStart` is per-video, so two videos at 0:30
   * would collide without it (Issue 5.20). `null` = unknown source, its own namespace.
   */
  sourceId?: string | null;
  windowedGroupId?: string;
  wordId?: string;
  captionId?: string;
  provisional?: boolean;
  capturedAtEpochMs?: number;
};

type Bucket = {
  words: Word[];
  lastAccess: number;
  /** First video second of bucket — kept separately because key is stringified. */
  anchorTime: number;
  ranges: VideoRange[];
};

export type WindowedResult = WindowedPatch<Word> & { mode: 'windowed' };

function normalizeSource(sourceId: string | null | undefined): string | null {
  // `undefined` and `null` are the SAME namespace (unknown source). Without this,
  // words with `undefined` (old sidecar/tests) never match queries with `null`.
  return sourceId ?? null;
}

/** Cache key = (source, second) — a bare second collides across videos at 0:30 (Issue 5.20). */
function bucketKey(
  sourceId: string | null | undefined,
  videoStart: number,
): string {
  return `${normalizeSource(sourceId) ?? ''}|${videoStart}`;
}

/**
 * Translation for one caption group. Lookup prefers windowedGroupId/captionId, with
 * captionStart as the legacy fallback; the translation only fits the full group text.
 */
export type SentenceTranslation = {
  windowedGroupId?: string;
  captionId?: string;
  captionStart: number;
  text: string;
  vi: string;
  /** Video identity — without it, a bare `captionStart` returns video A's translation for video B (Issue 5.20). */
  sourceId?: string | null;
};

type TranslationBucket = {
  t: SentenceTranslation;
  lastAccess: number;
};

type WindowedTranslationHistory = {
  sourceId: string | null;
  text: string;
  range: VideoRange;
  translation?: SentenceTranslation;
  currentId?: string;
  lastAccess: number;
};

@Injectable()
export class TranscriptService {
  private static readonly TTL_MS = 30 * 60 * 1000;
  private static readonly MAX_BUCKETS = 300;

  private readonly cache = new Map<string, Bucket>();
  private readonly streaming = new StreamingTranscriptStore();

  setScope(scope: CaptureScope): void {
    this.streaming.setScope(scope);
  }

  applyStreamingUpdate(
    update: unknown,
  ): { update: WordsUpdate; finalized: FinalCaption[] } | null {
    return this.streaming.apply(update);
  }

  getFinalizedCaptions(sourceId: string | null, from = 0): CaptionState[] {
    return this.streaming.getFinalized(sourceId, from).map((c) => c.state);
  }

  restoreSnapshot(
    scope: CaptureScope,
    words: unknown,
    translations: unknown,
  ): boolean {
    if (
      !Array.isArray(words) ||
      words.length > 5000 ||
      !Array.isArray(translations) ||
      translations.length > 300
    )
      return false;
    if (
      !words.every(
        (w) =>
          validWord(w) &&
          w.provisional !== true &&
          (w.captionId === undefined ||
            (typeof w.captionId === 'string' &&
              w.captionId.length > 0 &&
              w.captionId.length <= 256 &&
              typeof w.wordId === 'string' &&
              w.wordId.length > 0 &&
              w.wordId.length <= 256 &&
              w.provisional === false)),
      )
    )
      return false;
    if (
      !translations.every(
        (t) =>
          t &&
          typeof t === 'object' &&
          Number.isFinite(t.captionStart) &&
          t.captionStart >= 0 &&
          typeof t.text === 'string' &&
          t.text.length <= 10000 &&
          typeof t.vi === 'string' &&
          t.vi.length <= 10000 &&
          (t.captionId === undefined ||
            (typeof t.captionId === 'string' && t.captionId.length <= 256)),
      )
    )
      return false;
    const groups = new Map<string, Word[]>();
    const legacy: Word[] = [];
    const seen = new Set<string>();
    for (const raw of words as Word[]) {
      const w = { ...raw, sourceId: scope.sourceId };
      if (!w.captionId) {
        legacy.push(w);
        continue;
      }
      if (seen.has(w.wordId!)) return false;
      seen.add(w.wordId!);
      const group = groups.get(w.captionId) ?? [];
      if (group.some((old) => old.captionStart !== w.captionStart))
        return false;
      group.push(w);
      groups.set(w.captionId, group);
    }
    for (const members of groups.values())
      members.sort((a, b) => a.videoStart - b.videoStart);
    const entries = [...groups].map(([captionId, members]) => ({
      state: {
        captionId,
        captionStart: members[0].captionStart,
        wordIds: members.map((w) => w.wordId!),
        finalized: true,
      },
      words: members.sort((a, b) => a.videoStart - b.videoStart),
      sourceId: scope.sourceId,
      lastAccess: Date.now(),
    }));
    const canonical = this.streaming.restore(scope.sourceId, entries);
    const restoredIds = new Map<string, string>();
    const current = this.windowedBuckets(scope.sourceId);
    const ordered = [...legacy].sort((a, b) => a.videoStart - b.videoStart);
    for (const [key, members] of groupWords(ordered)) {
      const indexes = members.map(w => ordered.indexOf(w));
      if (indexes[indexes.length - 1] - indexes[0] + 1 !== members.length) continue;
      const range = { from: members[0].videoStart, to: Math.max(...members.map(w => w.videoEnd)) };
      const identical = current.find(bucket => membership(bucket.words) === membership(members));
      if (identical) { restoredIds.set(key, identical.words[0].windowedGroupId!); continue; }
      if (current.some(bucket => bucket.ranges.some(coverage =>
        coverage.from < range.to && coverage.to > range.from ||
        coverage.from === range.from && coverage.to === range.to))) continue;
      const id = randomUUID();
      const bucket = { words: members.map(w => ({ ...w, windowedGroupId: id })),
        ranges: [range], anchorTime: range.from, lastAccess: Date.now() };
      this.cache.set(captionKey(scope.sourceId, id), bucket);
      current.push(bucket);
      restoredIds.set(key, id);
    }
    this.evict();
    for (const raw of translations as SentenceTranslation[]) {
      const entry = raw.captionId ? canonical.get(raw.captionId) : undefined;
      if (raw.captionId && !entry) continue;
      if (entry && entry.words.map((w) => w.w).join(' ') !== raw.text) continue;
      const restoredId = raw.captionId ? undefined : restoredIds.get(raw.windowedGroupId ?? `legacy:${raw.captionStart}`);
      if (!raw.captionId && (!restoredId || !this.isCurrentWindowedGroup(scope.sourceId, restoredId, raw.text))) continue;
      const t = {
        ...raw,
        ...(restoredId ? { windowedGroupId: restoredId } : {}),
        sourceId: scope.sourceId,
        ...(entry
          ? {
              captionId: entry.state.captionId,
              captionStart: entry.state.captionStart,
            }
          : {}),
      };
      if (!this.getTranslation(scope.sourceId, t.windowedGroupId ?? t.captionId ?? t.captionStart))
        this.setTranslation(t);
    }
    return true;
  }

  // Separate map from `cache`: words arrive continuously, translations arrive later (after AI call).
  private readonly translations = new Map<string, TranslationBucket>();
  // Hypothesis history is not display state; replay reads only `translations`.
  private readonly windowedTranslationHistory = new Map<string, WindowedTranslationHistory>();
  private windowedBuckets(sourceId: string | null | undefined): Bucket[] {
    for (const [key, bucket] of this.cache) {
      if (Date.now() - bucket.lastAccess > TranscriptService.TTL_MS) this.cache.delete(key);
    }
    return [...this.cache.values()].filter(bucket =>
      normalizeSource(bucket.words[0]?.sourceId) === normalizeSource(sourceId));
  }

  addWords(words: Word[]): WindowedResult {
    const empty: WindowedResult = { mode: 'windowed', words: [], replaceRanges: [], removedWindowedGroupIds: [] };
    if (!words.length || !words.every(validWord)) return empty;
    const source = normalizeSource(words[0].sourceId);
    if (words.some(w => normalizeSource(w.sourceId) !== source || w.wordId)) return empty;
    const buckets = this.windowedBuckets(source);
    const old = buckets.flatMap(bucket => bucket.words).sort((a, b) => a.videoStart - b.videoStart);
    const range = { from: Math.min(...words.map(w => w.videoStart)), to: Math.max(...words.map(w => w.videoEnd)) };
    const previous = groupWords(old);
    const inputRuns = normalizeRuns(words, [], randomUUID);
    const incoming = [...groupWords(inputRuns).values()].flatMap(group => {
      const ordered = [...group].sort((a, b) => a.videoStart - b.videoStart);
      const match = [...previous.values()].find(members => membership(members) === membership(ordered));
      const id = match?.[0].windowedGroupId ?? randomUUID();
      return ordered.map(w => ({ ...w, windowedGroupId: id }));
    });
    const incomingIds = new Set(incoming.map(w => w.windowedGroupId));
    // Old words replaced only if they start inside batch range (`isReplaced`);
    // words starting before left edge are overlap from prior window.
    const kept = old.filter(w => !incomingIds.has(w.windowedGroupId!) && !isReplaced(w, range, incoming));
    const admitted = dropClippedHeads(kept, incoming, [range]);
    const reference = old.filter(w => !incomingIds.has(w.windowedGroupId!)).concat(admitted);
    const next = normalizeRuns(kept.concat(admitted), reference, randomUUID);
    const groups = groupWords(next);
    const removed = [...previous.keys()].filter(id => !groups.has(id));
    const currentGroups = [...groups];
    const rangeOf = (members: Word[]): VideoRange => ({
      from: Math.min(...members.map(w => w.videoStart)),
      to: Math.max(...members.map(w => w.videoEnd)),
    });
    const history = this.windowedTranslationHistory;
    const historyNow = Date.now();
    for (const [key, entry] of history) {
      if (historyNow - entry.lastAccess > TranscriptService.TTL_MS) history.delete(key);
    }
    for (const [oldId, members] of previous) {
      const text = members.map(w => w.w).join(' ');
      let entry = [...history.values()].find(h => h.sourceId === source && h.currentId === oldId);
      if (!entry) {
        entry = { sourceId: source, text, range: rangeOf(members),
          currentId: oldId, lastAccess: historyNow };
        history.set(captionKey(source, oldId), entry);
      }
      const translation = this.getTranslation(source, oldId);
      if (translation && normalizeSource(translation.sourceId) === source && translation.text === text)
        entry.translation = { ...translation };
    }
    const candidates = [...history.values()].filter(h => h.sourceId === source).map(entry => ({
      entry,
      newIds: currentGroups.filter(([, members]) => {
        const range = rangeOf(members);
        return members.map(w => w.w).join(' ') === entry.text &&
          entry.range.from < range.to && entry.range.to > range.from;
      }).map(([id]) => id),
    }));
    const historyByNew = new Map<string, WindowedTranslationHistory[]>();
    for (const candidate of candidates) {
      for (const id of candidate.newIds) {
        const matches = historyByNew.get(id) ?? [];
        matches.push(candidate.entry);
        historyByNew.set(id, matches);
      }
    }
    // Even untranslated occurrences block ambiguity. Only 1:1 lineage;
    // keep original range so jitter doesn't drift translation to adjacent occurrence.
    for (const { entry, newIds } of candidates) {
      if (entry.currentId && groups.has(entry.currentId)) continue;
      if (newIds.length !== 1) continue;
      const [id] = newIds;
      if (previous.has(id) || historyByNew.get(id)?.length !== 1) continue;
      entry.currentId = id;
      if (incomingIds.has(id)) entry.lastAccess = historyNow;
      if (!entry.translation || this.getTranslation(source, id)) continue;
      this.setTranslation({ ...entry.translation, windowedGroupId: id,
        captionStart: groups.get(id)![0].captionStart, sourceId: source });
    }
    if (history.size > TranscriptService.MAX_BUCKETS) {
      const oldest = [...history].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
      for (const [key] of oldest.slice(0, history.size - TranscriptService.MAX_BUCKETS)) history.delete(key);
    }
    for (const id of removed) this.translations.delete(captionKey(source, id));
    const affected = next.filter(w => !previous.has(w.windowedGroupId!) || incomingIds.has(w.windowedGroupId!));
    const now = Date.now();
    const liveGroups = [...groups].filter(([id]) => incomingIds.has(id));
    const liveRanges = new Map(liveGroups.map(([id, members], index) => [id, {
      from: index === 0 ? range.from : members[0].videoStart,
      to: index + 1 < liveGroups.length ? liveGroups[index + 1][1][0].videoStart : range.to,
    }]));
    for (const [key, bucket] of this.cache) {
      if (normalizeSource(bucket.words[0]?.sourceId) === source && !groups.has(bucket.words[0]?.windowedGroupId!)) this.cache.delete(key);
    }
    for (const [id, members] of groups) {
      const key = captionKey(source, id);
      const existing = this.cache.get(key);
      if (existing && !incomingIds.has(id)) continue;
      const from = Math.min(...members.map(w => w.videoStart));
      const to = Math.max(...members.map(w => w.videoEnd));
      this.cache.set(key, { words: members, lastAccess: now, anchorTime: from,
        ranges: [liveRanges.get(id) ?? { from, to }] });
    }
    this.evict();
    return { mode: 'windowed', words: affected, replaceRanges: [range], removedWindowedGroupIds: removed };
  }

  getWindowedReplay(sourceId: string | null | undefined, fromSec: number): WindowedResult {
    const all = this.windowedBuckets(sourceId);
    const selected = all.filter(bucket => bucket.ranges.some(range => range.to >= fromSec));
    const coverage = selected.flatMap(bucket => bucket.ranges);
    const buckets = all.filter(bucket => selected.includes(bucket) || bucket.words.some(word => coverage.some(range => intersects(word, range))));
    for (const bucket of buckets) bucket.lastAccess = Date.now();
    return { mode: 'windowed', words: buckets.flatMap(bucket => bucket.words).sort((a, b) => a.videoStart - b.videoStart),
      replaceRanges: buckets.flatMap(bucket => bucket.ranges), removedWindowedGroupIds: [] };
  }

  isCurrentWindowedGroup(sourceId: string | null, id: string, text: string): boolean {
    const members = this.windowedBuckets(sourceId).flatMap(bucket => bucket.words).filter(w => w.windowedGroupId === id);
    return members.length > 0 && members.map(w => w.w).join(' ') === text;
  }

  /** Words in `[fromSec, toSec]` for this source only — unfiltered, two videos in the same range would mix. */
  getRange(
    sourceId: string | null | undefined,
    fromSec: number,
    toSec: number,
  ) {
    let result: Word[] = [];
    const now = Date.now();
    for (const [key, bucket] of this.cache) {
      if (now - bucket.lastAccess > TranscriptService.TTL_MS) {
        this.cache.delete(key);
      }
    }
    for (const bucket of this.cache.values()) {
      if (
        normalizeSource(bucket.words[0]?.sourceId) !== normalizeSource(sourceId)
      ) {
        continue;
      }
      const lastWord = bucket.words[bucket.words.length - 1];
      const bucketEnd = lastWord?.videoEnd ?? bucket.anchorTime;
      if (bucket.anchorTime <= toSec && bucketEnd >= fromSec) {
        bucket.lastAccess = now;
        result = result.concat(bucket.words);
      }
    }

    result.sort((a, b) => a.videoStart - b.videoStart);
    return result
      .concat(
        this.streaming.getFinalized(sourceId, fromSec).flatMap((c) => c.words),
      )
      .filter((word) => word.videoStart >= fromSec && word.videoStart <= toSec)
      .sort((a, b) => a.videoStart - b.videoStart);
  }

  /**
   * Everything watched from `fromSec` onward, for replay after a seek. No upper bound —
   * TTL/LRU already caps memory, and a window cap would re-expose the ~2s transcribe
   * latency for data sitting in cache. Must select by OVERLAP (`bucketEnd >= fromSec`),
   * not "starts after": buckets are keyed by their first word and can straddle the seek
   * point (Issue 5.35).
   */
  getRangeFrom(sourceId: string | null | undefined, fromSec: number): Word[] {
    const now = Date.now();

    for (const [key, bucket] of this.cache) {
      if (now - bucket.lastAccess > TranscriptService.TTL_MS) {
        this.cache.delete(key);
      }
    }

    const source = normalizeSource(sourceId);
    const result: Word[] = [];
    for (const bucket of this.cache.values()) {
      if (normalizeSource(bucket.words[0]?.sourceId) !== source) continue;
      // Bucket ending before seek point is irrelevant
      const lastWord = bucket.words[bucket.words.length - 1];
      const bucketEnd = lastWord?.videoEnd ?? bucket.anchorTime;
      if (bucketEnd < fromSec) continue;
      bucket.lastAccess = now;
      result.push(...bucket.words);
    }

    result.sort((a, b) => a.videoStart - b.videoStart);
    const deduped = result;
    return deduped
      .filter((word) => word.videoStart >= fromSec)
      .concat(
        this.streaming.getFinalized(source, fromSec).flatMap((c) => c.words),
      )
      .sort((a, b) => a.videoStart - b.videoStart);
  }
  private evict() {
    while (this.cache.size > TranscriptService.MAX_BUCKETS) {
      let oldestKey: string | undefined;
      let oldestAccess = Infinity;

      for (const [key, bucket] of this.cache) {
        if (bucket.lastAccess < oldestAccess) {
          oldestAccess = bucket.lastAccess;
          oldestKey = key;
        }
      }

      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
  }

  /** Cached translation for this group from the correct source, if any. */
  getTranslation(
    sourceId: string | null | undefined,
    captionStart: number | string,
  ): SentenceTranslation | undefined {
    const key =
      typeof captionStart === 'string'
        ? captionKey(sourceId, captionStart)
        : bucketKey(sourceId, captionStart);
    const bucket = this.translations.get(key);
    if (!bucket) return undefined;
    if (Date.now() - bucket.lastAccess > TranscriptService.TTL_MS) {
      this.translations.delete(key);
      return undefined;
    }
    bucket.lastAccess = Date.now();
    return bucket.t;
  }

  setTranslation(t: SentenceTranslation): void {
    this.translations.set(
      (t.windowedGroupId ?? t.captionId)
        ? captionKey(t.sourceId, (t.windowedGroupId ?? t.captionId)!)
        : bucketKey(t.sourceId, t.captionStart),
      {
        t,
        lastAccess: Date.now(),
      },
    );
    this.evictTranslations();
  }

  /** Translations for groups in `[fromSec, toSec]`, sorted by video timestamp. */
  getTranslations(
    sourceId: string | null | undefined,
    fromSec: number,
    toSec: number,
  ): SentenceTranslation[] {
    const now = Date.now();
    const result: SentenceTranslation[] = [];

    for (const [key, bucket] of this.translations) {
      if (now - bucket.lastAccess > TranscriptService.TTL_MS) {
        this.translations.delete(key);
        continue;
      }
      if (normalizeSource(bucket.t.sourceId) !== normalizeSource(sourceId)) {
        continue;
      }
      if (bucket.t.captionStart >= fromSec && bucket.t.captionStart <= toSec) {
        bucket.lastAccess = now;
        result.push(bucket.t);
      }
    }

    return result.sort((a, b) => a.captionStart - b.captionStart);
  }

  /** Translations for all groups watched from `fromSec` onward — companion to `getRangeFrom`. */
  getTranslationsFrom(
    sourceId: string | null | undefined,
    fromSec: number,
  ): SentenceTranslation[] {
    const now = Date.now();
    const result: SentenceTranslation[] = [];
    const source = normalizeSource(sourceId);
    const replayWindowedIds = new Set(this.getWindowedReplay(source, fromSec).words.map(w => w.windowedGroupId));
    const replayCaptionIds = new Set(
      this.streaming
        .getFinalized(source, fromSec)
        .map((c) => c.state.captionId),
    );

    for (const [key, bucket] of this.translations) {
      if (now - bucket.lastAccess > TranscriptService.TTL_MS) {
        this.translations.delete(key);
        continue;
      }
      if (normalizeSource(bucket.t.sourceId) !== source) continue;
      if (bucket.t.windowedGroupId) {
        if (replayWindowedIds.has(bucket.t.windowedGroupId) && this.isCurrentWindowedGroup(source, bucket.t.windowedGroupId, bucket.t.text)) result.push(bucket.t);
        continue;
      }
      if (
        bucket.t.captionStart < fromSec &&
        (!bucket.t.captionId || !replayCaptionIds.has(bucket.t.captionId))
      )
        continue;
      bucket.lastAccess = now;
      result.push(bucket.t);
    }

    return result.sort((a, b) => a.captionStart - b.captionStart);
  }

  private evictTranslations() {
    while (this.translations.size > TranscriptService.MAX_BUCKETS) {
      let oldestKey: string | undefined;
      let oldestAccess = Infinity;

      for (const [key, bucket] of this.translations) {
        if (bucket.lastAccess < oldestAccess) {
          oldestAccess = bucket.lastAccess;
          oldestKey = key;
        }
      }

      if (oldestKey !== undefined) {
        this.translations.delete(oldestKey);
      }
    }
  }
}
