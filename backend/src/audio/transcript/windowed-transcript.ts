export type VideoRange = { from: number; to: number };
export type WindowedWord = {
  w: string; s: number; e: number; videoStart: number; videoEnd: number;
  captionStart: number; c: number; sourceId?: string | null;
  windowedGroupId?: string;
};
export type WindowedPatch<T extends WindowedWord = WindowedWord> = {
  words: T[]; replaceRanges: VideoRange[]; removedWindowedGroupIds: string[];
};

// Từ đầu cửa sổ luôn có videoStart == range.from; sai số làm tròn 0.01 nên lấy dư.
const EDGE_EPSILON = 0.05;
// Batch chỉ "nghe lại" được từ bắt đầu trước mép nếu mốc của nó xê dịch trong khoảng
// này. Xa hơn là lần nói khác, không phải cùng một từ được decode lại.
const REDERIVE_TOLERANCE = 1.3;

export function intersects(word: WindowedWord, range: VideoRange): boolean {
  if (range.from === range.to) return word.videoStart === word.videoEnd && word.videoStart === range.from;
  if (word.videoStart === word.videoEnd) return word.videoStart >= range.from && word.videoStart < range.to;
  return word.videoStart < range.to && word.videoEnd > range.from;
}

/**
 * Từ cũ có bị batch mới thay không.
 *
 * Cửa sổ trượt 2s chồng nhau 1s. Từ bắt đầu TRƯỚC mép trái nằm trọn trong vùng
 * chồng và batch mới chỉ nghe được phần đuôi của nó — thay bằng giao khoảng ở đây
 * là tự xoá từ mà cửa sổ trước đã nghe đúng (`teeth` → mảnh cụt `If`, Issue 5.52).
 * Chỉ thay khi batch thực sự decode lại được chính từ đó: cùng chữ, cùng mốc.
 */
export function isReplaced(word: WindowedWord, range: VideoRange,
                           incoming: WindowedWord[] = []): boolean {
  if (range.from === range.to) return word.videoStart === word.videoEnd && word.videoStart === range.from;
  if (word.videoStart >= range.from) return word.videoStart < range.to;
  return incoming.some(other => sameText(other, word) &&
    Math.abs(other.videoStart - word.videoStart) < REDERIVE_TOLERANCE);
}

/**
 * Từ mở đầu batch chỉ là đuôi bị cắt của một từ cũ đang giữ → là mảnh cụt, phải bỏ.
 *
 * Cửa sổ cắt ngang từ đang nói: cửa sổ trước nghe trọn `teeth 14.42-14.68`, cửa sổ
 * sau mở đầu ở 14.46 và nghe ra `If 14.46-14.74` với confidence thấp. Hai bên gần
 * như trùng mốc nên không tách được bằng vị trí hay confidence; dấu hiệu phân biệt
 * là trung điểm mảnh cụt rơi vào bên trong một từ cũ đang giữ.
 */
export function isClippedHead(word: WindowedWord, range: VideoRange, kept: WindowedWord[]): boolean {
  if (range.from === range.to || word.videoStart > range.from + EDGE_EPSILON) return false;
  const mid = (word.videoStart + word.videoEnd) / 2;
  return kept.some(other => other.videoStart < range.from && mid > other.videoStart && mid < other.videoEnd);
}

function sameText(left: WindowedWord, right: WindowedWord): boolean {
  return left.w.trim().toLowerCase() === right.w.trim().toLowerCase();
}

/** Lọc hai nửa của cùng một luật: giữ từ cũ, bỏ mảnh cụt mở đầu batch. */
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
    !patch.replaceRanges.some(range => isReplaced(w, range, patch.words)));
  const words = dropClippedHeads(kept, patch.words, patch.replaceRanges);
  return normalizeRuns(kept.concat(words), history.filter(w => !incoming.has(w.windowedGroupId)).concat(words), newId);
}
