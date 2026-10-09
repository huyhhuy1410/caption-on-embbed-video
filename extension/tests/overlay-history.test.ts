import test from "node:test";
import assert from "node:assert/strict";
import { CaptionOverlay } from "../src/content/overlay";
import { TranscriptState } from "../src/shared/transcript-state";
import type { CaptionWord } from "../src/shared/protocol";
import { serializeTranscript } from "../src/content/transcript-export";

function word(w: string, start: number): CaptionWord {
  return { w, s: start, e: start + 0.5, videoStart: start,
    videoEnd: start + 0.5, captionStart: start, c: 0.9, sourceId: "video-a" };
}

function overlay(): CaptionOverlay {
  // Test state bằng method thật; bỏ DOM rendering để chạy được trong Node.
  return Object.assign(Object.create(CaptionOverlay.prototype), {
    words: [], transcript: new TranscriptState(),
    firstRendered: new Set(), finalizedRendered: new Set(),
    translationHistory: new Map(), translations: new Map(),
    renderedByKey: new Map(), renderedLines: [], followButton: { hidden: true },
    lineHost: { textContent: "", scrollTop: 0 },
    reconcileLines() {},
  });
}

test("successive live batches retain all watched caption lines", () => {
  const view = overlay();
  view.setWords([word("First", 1)]);
  view.setWords([word("Second", 5)]);
  view.setWords([word("Third", 9)]);
  assert.deepEqual(view.finalizedHistory().words.map(w => w.w), ["First", "Second", "Third"]);
});

test("partial replay keeps earlier watched lines and deduplicates repeated words", () => {
  const view = overlay();
  view.setWords([word("First", 1), word("Second", 5)]);
  view.mergeReplay([word("Second", 5), word("Third", 9)]);
  view.mergeReplay([word("Second", 5), word("Third", 9)]);
  assert.deepEqual(view.finalizedHistory().words.map(w => w.w), ["First", "Second", "Third"]);
});

test("canonical replacement keeps real repetitions and rejects stale Vietnamese", () => {
  const view = overlay();
  Object.assign(view, { autoScroll: false });
  const old = [word("old", 1), word("sentence", 1.3)].map(w => ({ ...w, windowedGroupId: "old" }));
  view.applyWindowedPatch({ words: old, replaceRanges: [{ from: 1, to: 1.8 }], removedWindowedGroupIds: [] });
  view.setTranslations([{ windowedGroupId: "old", captionStart: 1, text: "old sentence", vi: "old VI" }]);
  const next = [word("no", 1), word("no", 1.3)].map(w => ({ ...w, windowedGroupId: "new" }));
  const patch = { words: next, replaceRanges: [{ from: 1, to: 1.8 }], removedWindowedGroupIds: ["old"] };
  view.applyWindowedPatch(patch);
  view.applyWindowedPatch(patch);
  view.setTranslations([{ windowedGroupId: "old", captionStart: 1, text: "old sentence", vi: "late VI" },
    { windowedGroupId: "new", captionStart: 1, text: "wrong text", vi: "wrong VI" }]);
  assert.deepEqual(view.finalizedHistory().words.map(w => w.w), ["no", "no"]);
  assert.deepEqual(view.finalizedHistory().translations, []);
  assert.equal(serializeTranscript("txt", next, []), "no no\n");
});

test("disjoint authoritative replay retains history in the unwatched gap", () => {
  const view = overlay();
  view.setWords([word("middle", 10)]);
  const patch = { words: [{ ...word("first", 1), windowedGroupId: "first" },
    { ...word("last", 20), windowedGroupId: "last" }],
    replaceRanges: [{ from: 1, to: 1.5 }, { from: 20, to: 20.5 }], removedWindowedGroupIds: [] };
  view.applyWindowedPatch(patch);
  assert.deepEqual(view.finalizedHistory().words.map(w => w.w), ["first", "middle", "last"]);
});

function highlightedAt(view: CaptionOverlay, time: number): CaptionWord | null {
  let active: CaptionWord | null = null;
  Object.assign(view, {
    autoScroll: false,
    setActiveWord(word: CaptionWord | null) { active = word; },
  });
  view.update(time);
  return active;
}

test("highlight uses the half-open word interval, not only its start", () => {
  const view = overlay();
  view.setWords([word("First", 1), word("Second", 2)]);
  assert.equal(highlightedAt(view, 0.99), null);
  assert.equal(highlightedAt(view, 1)?.w, "First");
  assert.equal(highlightedAt(view, 1.49)?.w, "First");
  assert.equal(highlightedAt(view, 1.5), null);
  assert.equal(highlightedAt(view, 1.99), null);
  assert.equal(highlightedAt(view, 2)?.w, "Second");
  assert.equal(highlightedAt(view, 2.5), null);
});

test("late ASR batch stays in history without highlighting its expired tail", () => {
  const view = overlay();
  view.setWords([{ ...word("and", 6.96), videoEnd: 7.38 }]);
  assert.equal(highlightedAt(view, 9.626515), null);
  assert.deepEqual(view.finalizedHistory().words.map(w => w.w), ["and"]);
  assert.equal(highlightedAt(view, 7.1)?.w, "and");
});

test("seek selects words at the video clock and clears highlight after the final word", () => {
  const view = overlay();
  view.setWords([word("First", 1), word("Second", 5)]);
  assert.equal(highlightedAt(view, 5.2)?.w, "Second");
  assert.equal(highlightedAt(view, 1.2)?.w, "First");
  assert.equal(highlightedAt(view, 6), null);
});

test("zero-duration ASR token is never held as an active word", () => {
  const view = overlay();
  view.setWords([{ ...word("-", 11.4), videoEnd: 11.4 }]);
  assert.equal(highlightedAt(view, 11.4), null);
  assert.equal(highlightedAt(view, 12), null);
});

test("clear removes history before new video batches are added", () => {
  const view = overlay();
  view.setWords([word("Old", 1), word("History", 5)]);
  view.clear();
  assert.deepEqual(view.finalizedHistory().words, []);
  view.setWords([{ ...word("New", 1), sourceId: "video-b" }]);
  view.setWords([{ ...word("Video", 5), sourceId: "video-b" }]);
  assert.deepEqual(view.finalizedHistory().words.map(w => w.w), ["New", "Video"]);
});
