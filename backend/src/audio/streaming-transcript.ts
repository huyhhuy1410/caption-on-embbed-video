export type CaptureScope = {
  sessionId: string;
  generation: number;
  sourceId: string | null;
};
export type StreamingWord = {
  w: string;
  s: number;
  e: number;
  videoStart: number;
  videoEnd: number;
  captionStart: number;
  c: number;
  sourceId?: string | null;
  wordId?: string;
  captionId?: string;
  provisional?: boolean;
  capturedAtEpochMs?: number;
};
export type CaptionState = {
  captionId: string;
  captionStart: number;
  wordIds: string[];
  finalized: boolean;
};
export type WordsUpdate = CaptureScope & {
  type: 'words';
  mode: 'streaming';
  revision: number;
  words: StreamingWord[];
  removedWordIds: string[];
  captions: CaptionState[];
  removedCaptionIds: string[];
  language?: string;
  languageProbability?: number;
  voiced?: boolean;
};
export type FinalCaption = {
  state: CaptionState;
  words: StreamingWord[];
  sourceId: string | null;
  lastAccess: number;
};
export const captionKey = (
  sourceId: string | null | undefined,
  id: string | number,
) => JSON.stringify([sourceId ?? null, typeof id, id]);
export function isScope(
  value: unknown,
): value is CaptureScope & Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const v = value as CaptureScope;
  return (
    typeof v.sessionId === 'string' &&
    v.sessionId.length > 0 &&
    v.sessionId.length <= 256 &&
    Number.isSafeInteger(v.generation) &&
    v.generation >= 0 &&
    (v.sourceId === null ||
      (typeof v.sourceId === 'string' && v.sourceId.length <= 2048))
  );
}
export function sameScope(
  a: CaptureScope | undefined,
  b: CaptureScope,
): boolean {
  return (
    !!a &&
    a.sessionId === b.sessionId &&
    a.generation === b.generation &&
    a.sourceId === b.sourceId
  );
}
export function validWord(value: unknown): value is StreamingWord {
  if (!value || typeof value !== 'object') return false;
  const w = value as StreamingWord;
  return (
    typeof w.w === 'string' &&
    w.w.length > 0 &&
    w.w.length <= 512 &&
    [w.s, w.e, w.videoStart, w.videoEnd, w.captionStart, w.c].every(
      Number.isFinite,
    ) &&
    w.s >= 0 &&
    w.e >= w.s &&
    w.videoStart >= 0 &&
    w.videoEnd >= w.videoStart &&
    w.captionStart >= 0 &&
    (w.capturedAtEpochMs === undefined || Number.isFinite(w.capturedAtEpochMs))
  );
}
const validId = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 256;
const ids = (v: unknown): v is string[] =>
  Array.isArray(v) &&
  v.length <= 5000 &&
  v.every(validId) &&
  new Set(v).size === v.length;
const equal = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => equal(v, b[i]))
    );
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => equal(left[key], right[key]));
};

export class StreamingTranscriptStore {
  private scope?: CaptureScope;
  private revision = 0;
  private words = new Map<string, StreamingWord>();
  private captions = new Map<string, CaptionState>();
  private readonly history = new Map<string, FinalCaption>();
  private readonly aliases = new Map<string, FinalCaption>();
  private static readonly TTL = 30 * 60_000;

  setScope(scope: CaptureScope): void {
    if (sameScope(this.scope, scope)) return;
    this.scope = { ...scope };
    this.revision = 0;
    this.words.clear();
    this.captions.clear();
    this.aliases.clear();
  }

  apply(
    value: unknown,
  ): { update: WordsUpdate; finalized: FinalCaption[] } | null {
    if (!isScope(value) || !sameScope(this.scope, value)) return null;
    const u = value as WordsUpdate;
    if (
      u.type !== 'words' ||
      u.mode !== 'streaming' ||
      !Number.isSafeInteger(u.revision) ||
      u.revision <= this.revision ||
      !Array.isArray(u.words) ||
      u.words.length > 5000 ||
      !u.words.every(
        (w) =>
          validWord(w) &&
          validId(w.wordId) &&
          validId(w.captionId) &&
          typeof w.provisional === 'boolean' &&
          (w.sourceId ?? null) === u.sourceId,
      ) ||
      new Set(u.words.map((w) => w.wordId)).size !== u.words.length ||
      !ids(u.removedWordIds) ||
      !ids(u.removedCaptionIds) ||
      !Array.isArray(u.captions) ||
      u.captions.length > 300 ||
      !u.captions.every(
        (c) =>
          c &&
          validId(c.captionId) &&
          Number.isFinite(c.captionStart) &&
          c.captionStart >= 0 &&
          ids(c.wordIds) &&
          c.wordIds.length > 0 &&
          typeof c.finalized === 'boolean',
      ) ||
      new Set(u.captions.map((c) => c.captionId)).size !== u.captions.length
    )
      return null;
    const words = new Map(this.words);
    const captions = new Map(this.captions);
    for (const id of u.removedCaptionIds) {
      const c = captions.get(id);
      if (c?.finalized) return null;
      for (const wordId of c?.wordIds ?? []) words.delete(wordId);
      captions.delete(id);
    }
    for (const id of u.removedWordIds) {
      if (words.get(id)?.provisional === false) return null;
      words.delete(id);
    }
    for (const w of u.words) {
      const old = words.get(w.wordId!);
      if (old?.provisional === false && !equal(old, w)) return null;
      words.set(w.wordId!, { ...w, sourceId: u.sourceId });
    }
    for (const c of u.captions) {
      const old = captions.get(c.captionId);
      if (old?.finalized && !equal(old, c)) return null;
      captions.set(c.captionId, { ...c, wordIds: [...c.wordIds] });
    }
    while (words.size > 5000 || captions.size > 300) {
      const oldest = [...captions.values()].find(
        (c) =>
          c.finalized &&
          !u.captions.some((changed) => changed.captionId === c.captionId),
      );
      if (!oldest) return null;
      oldest.wordIds.forEach((id) => words.delete(id));
      captions.delete(oldest.captionId);
    }
    const members = new Set<string>();
    for (const c of captions.values()) {
      for (const id of c.wordIds) {
        const w = words.get(id);
        if (
          !w ||
          w.captionId !== c.captionId ||
          w.captionStart !== c.captionStart ||
          members.has(id) ||
          (c.finalized && w.provisional !== false)
        )
          return null;
        members.add(id);
      }
    }
    if (members.size !== words.size) return null;

    // Commit only after all membership checks pass; invalid revision must not lose suffix.
    const finalized: FinalCaption[] = [];
    const emittedWords = [...u.words];
    const emittedCaptions = [...u.captions];
    const removedWords = new Set(u.removedWordIds);
    const removedCaptions = new Set(u.removedCaptionIds);
    this.prune();
    const changedIds = new Set([
      ...u.captions.map((c) => c.captionId),
      ...u.words.map((w) => w.captionId!),
    ]);
    for (const c of [...captions.values()].filter((c) =>
      changedIds.has(c.captionId),
    )) {
      const captionWords = c.wordIds.map((id) => words.get(id)!);
      const cached =
        this.aliases.get(c.captionId) ??
        this.history.get(captionKey(u.sourceId, c.captionId)) ??
        this.findExisting(u.sourceId, captionWords);
      if (
        cached &&
        cached.state.captionId === c.captionId &&
        this.captions.get(c.captionId)?.finalized
      )
        continue;
      if (cached) {
        this.aliases.set(c.captionId, cached);
        cached.lastAccess = Date.now();
        // History finalized is the canonical timeline after seek; don't re-emit just-assigned IDs.
        captionWords.forEach((w) => {
          if (!cached.words.some((old) => old.wordId === w.wordId))
            removedWords.add(w.wordId!);
        });
        if (c.captionId !== cached.state.captionId)
          removedCaptions.add(c.captionId);
        emittedWords.push(...cached.words);
        emittedCaptions.push(cached.state);
      } else if (c.finalized) {
        const entry = {
          state: c,
          words: captionWords,
          sourceId: u.sourceId,
          lastAccess: Date.now(),
        };
        this.history.set(captionKey(u.sourceId, c.captionId), entry);
        finalized.push(entry);
      }
    }
    for (const id of this.aliases.keys())
      if (!captions.has(id)) this.aliases.delete(id);
    this.words = words;
    this.captions = captions;
    this.revision = u.revision;
    this.prune();
    return {
      update: {
        ...u,
        words: [
          ...new Map(
            emittedWords
              .filter((w) => !removedWords.has(w.wordId!))
              .map((w) => [w.wordId, w]),
          ).values(),
        ],
        captions: [
          ...new Map(
            emittedCaptions
              .filter((c) => !removedCaptions.has(c.captionId))
              .map((c) => [c.captionId, c]),
          ).values(),
        ],
        removedWordIds: [...removedWords],
        removedCaptionIds: [...removedCaptions],
      },
      finalized,
    };
  }

  private findExisting(
    sourceId: string | null,
    words: StreamingWord[],
    excludeCurrent = true,
  ): FinalCaption | undefined {
    const from = Math.min(...words.map((w) => w.videoStart));
    const to = Math.max(...words.map((w) => w.videoEnd));
    return [...this.history.values()].find((c) => {
      if (
        c.sourceId !== sourceId ||
        (excludeCurrent && this.captions.get(c.state.captionId)?.finalized)
      )
        return false;
      const start = Math.min(...c.words.map((w) => w.videoStart));
      const end = Math.max(...c.words.map((w) => w.videoEnd));
      const overlap = Math.min(to, end) - Math.max(from, start);
      const sameText =
        c.words.map((w) => w.w.toLowerCase()).join(' ') ===
        words.map((w) => w.w.toLowerCase()).join(' ');
      return (
        (overlap > 0 &&
          overlap / Math.max(0.01, Math.min(to - from, end - start)) >= 0.7) ||
        (sameText && Math.abs(from - start) <= 1.5 && Math.abs(to - end) <= 1.5)
      );
    });
  }

  getFinalized(sourceId: string | null | undefined, from = 0): FinalCaption[] {
    this.prune();
    const result = [...this.history.values()].filter(
      (c) =>
        c.sourceId === (sourceId ?? null) &&
        c.words.some((w) => w.videoEnd >= from),
    );
    result.forEach((c) => (c.lastAccess = Date.now()));
    return result.sort((a, b) => a.state.captionStart - b.state.captionStart);
  }

  restore(
    sourceId: string | null,
    groups: FinalCaption[],
  ): Map<string, FinalCaption> {
    const reconciled = new Map<string, FinalCaption>();
    this.prune();
    for (const group of groups) {
      const existing =
        this.history.get(captionKey(sourceId, group.state.captionId)) ??
        this.findExisting(sourceId, group.words, false);
      const canonical = existing ?? group;
      reconciled.set(group.state.captionId, canonical);
      if (!existing)
        this.history.set(captionKey(sourceId, group.state.captionId), group);
    }
    this.prune();
    return reconciled;
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, c] of this.history)
      if (now - c.lastAccess > StreamingTranscriptStore.TTL)
        this.history.delete(key);
    while (
      this.history.size > 300 ||
      [...this.history.values()].reduce((n, c) => n + c.words.length, 0) > 5000
    ) {
      const oldest = [...this.history.entries()].sort(
        (a, b) => a[1].lastAccess - b[1].lastAccess,
      )[0];
      if (!oldest) break;
      this.history.delete(oldest[0]);
    }
  }
}
