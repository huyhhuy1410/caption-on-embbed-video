export type VideoRange = { from: number; to: number };
export type WindowedWord = {
  w: string; s: number; e: number; videoStart: number; videoEnd: number;
  captionStart: number; c: number; sourceId?: string | null;
  windowedGroupId?: string;
};
export type WindowedPatch<T extends WindowedWord = WindowedWord> = {
  words: T[]; replaceRanges: VideoRange[]; removedWindowedGroupIds: string[];
};

// Rounding margin for window-edge comparison (0.01 precision → 0.05 headroom).
const EDGE_EPSILON = 0.05;
// Max timestamp drift for a word to count as "re-decoded" rather than a new utterance.
const REDERIVE_TOLERANCE = 1.3;

export function intersects(word: WindowedWord, range: VideoRange): boolean {
  if (range.from === range.to) return word.videoStart === word.videoEnd && word.videoStart === range.from;
  if (word.videoStart === word.videoEnd) return word.videoStart >= range.from && word.videoStart < range.to;
  return word.videoStart < range.to && word.videoEnd > range.from;
}

// Replace old word only if batch re-decodes it (same text, within 1.3s).
// Otherwise the overlap region keeps the prior window's correct decode (Issue 5.52).
export function isReplaced(word: WindowedWord, range: VideoRange,
                           incoming: WindowedWord[] = []): boolean {
  if (range.from === range.to) return word.videoStart === word.videoEnd && word.videoStart === range.from;
  if (word.videoStart >= range.from) return word.videoStart < range.to;
  return incoming.some(other => sameText(other, word) &&
    Math.abs(other.videoStart - word.videoStart) < REDERIVE_TOLERANCE);
}

// A word at range.from whose midpoint falls inside a kept word is a clipped tail of
// that kept word, not a new decode — drop it (Issue 5.52).
export function isClippedHead(word: WindowedWord, range: VideoRange, kept: WindowedWord[]): boolean {
  if (range.from === range.to || word.videoStart > range.from + EDGE_EPSILON) return false;
  const mid = (word.videoStart + word.videoEnd) / 2;
  return kept.some(other => other.videoStart < range.from && mid > other.videoStart && mid < other.videoEnd);
}

function sameText(left: WindowedWord, right: WindowedWord): boolean {
  return left.w.trim().toLowerCase() === right.w.trim().toLowerCase();
}

// Filter clipped heads from incoming batch, keeping prior window's complete words.
export function dropClippedHeads<T extends WindowedWord>(kept: T[], incoming: T[], ranges: VideoRange[]): T[] {
  return incoming.filter(word => !ranges.some(range => isClippedHead(word, range, kept)));
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

// Preserve group identity across runs; reassigning IDs would orphan translations.
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
    !patch.replaceRanges.some(range => isReplaced(w, range, patch.words)));
  const words = dropClippedHeads(kept, patch.words, patch.replaceRanges);
  return normalizeRuns(kept.concat(words), history.filter(w => !incoming.has(w.windowedGroupId)).concat(words), newId);
}
