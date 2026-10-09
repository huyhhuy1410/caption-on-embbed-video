export type VideoRange = { from: number; to: number };
export type WindowedWord = {
  w: string; s: number; e: number; videoStart: number; videoEnd: number;
  captionStart: number; c: number; sourceId?: string | null;
  windowedGroupId?: string;
};
export type WindowedPatch<T extends WindowedWord = WindowedWord> = {
  words: T[]; replaceRanges: VideoRange[]; removedWindowedGroupIds: string[];
};

export function intersects(word: WindowedWord, range: VideoRange): boolean {
  if (range.from === range.to) return word.videoStart === word.videoEnd && word.videoStart === range.from;
  if (word.videoStart === word.videoEnd) return word.videoStart >= range.from && word.videoStart < range.to;
  return word.videoStart < range.to && word.videoEnd > range.from;
}

export function membership(words: WindowedWord[]): string {
  return JSON.stringify(words.map(w => [w.w, w.s, w.e, w.videoStart, w.videoEnd, w.captionStart, w.c, w.sourceId ?? null]));
}

export function groupWords<T extends WindowedWord>(words: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const word of words) {
    const key = word.windowedGroupId ?? `legacy:${word.captionStart}`;
    const group = groups.get(key) ?? [];
    group.push(word);
    groups.set(key, group);
  }
  return groups;
}

// Một identity không được nối lại hai phía của nhóm mới; fragment mất bản dịch cũ.
export function normalizeRuns<T extends WindowedWord>(words: T[], original: T[], newId: () => string): T[] {
  const previous = groupWords(original);
  const sorted = [...words].sort((a, b) => a.videoStart - b.videoStart);
  const runs: T[][] = [];
  for (const word of sorted) {
    const run = runs[runs.length - 1];
    const key = word.windowedGroupId ?? `legacy:${word.captionStart}`;
    const last = run?.[0];
    if (last && (last.windowedGroupId ?? `legacy:${last.captionStart}`) === key) run.push(word);
    else runs.push([word]);
  }
  const used = new Set<string>();
  return runs.flatMap(run => {
    const id = run[0].windowedGroupId;
    const unchanged = id && !used.has(id) && previous.has(id) && membership(previous.get(id)!) === membership(run);
    const nextId = unchanged ? id : newId();
    used.add(nextId);
    return run.map(word => ({ ...word, windowedGroupId: nextId }));
  });
}

export function applyPatch<T extends WindowedWord>(history: T[], patch: WindowedPatch<T>, newId: () => string): T[] {
  const incoming = new Set(patch.words.map(w => w.windowedGroupId));
  const removed = new Set(patch.removedWindowedGroupIds);
  const kept = history.filter(w => !removed.has(w.windowedGroupId!) && !incoming.has(w.windowedGroupId) &&
    !patch.replaceRanges.some(range => intersects(w, range)));
  return normalizeRuns(kept.concat(patch.words), history.filter(w => !incoming.has(w.windowedGroupId)).concat(patch.words), newId);
}
