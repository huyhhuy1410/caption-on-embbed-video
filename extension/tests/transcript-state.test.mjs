import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const result = await build({ entryPoints: [fileURLToPath(new URL('../src/shared/transcript-state.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'node' });
const { TranscriptState } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const scope = { sessionId: 'session', generation: 1, sourceId: 'video' };
const word = (id, text = 'very', extra = {}) => ({ wordId: id, captionId: 'caption', w: text, s: 0, e: 0.2, c: 0.9, videoStart: 1, videoEnd: 1.2, captionStart: 1, sourceId: 'video', provisional: true, ...extra });
const update = (revision, words, extra = {}) => ({ type: 'words', mode: 'streaming', ...scope, revision, words,
  captions: [{ captionId: 'caption', captionStart: 1, wordIds: words.map(w => w.wordId), finalized: false }],
  removedWordIds: [], removedCaptionIds: [], ...extra });
const state = () => { const value = new TranscriptState(); value.setScope(scope); return value; };

test('stable identities preserve genuine repeated words and timestamp revisions', () => {
  const value = state();
  assert.equal(value.apply(update(1, [word('a'), word('b', 'very', { videoStart: 1.2, videoEnd: 1.4 })])), true);
  assert.equal(value.values().length, 2);
  assert.equal(value.apply(update(2, [word('a', 'quite', { videoStart: 2, videoEnd: 2.2 })], {
    captions: [{ captionId: 'caption', captionStart: 1, wordIds: ['b', 'a'], finalized: false }],
  })), true);
  assert.deepEqual(value.values().map(w => w.w), ['very', 'quite']);
});

test('shorter suffix/removal is atomic and stale revisions do not return', () => {
  const value = state();
  assert.equal(value.apply(update(2, [word('a'), word('b')])), true);
  assert.equal(value.apply(update(1, [word('old')])), false);
  assert.equal(value.apply(update(3, [word('a', 'new')], { removedWordIds: ['b'] })), true);
  assert.deepEqual(value.values().map(w => w.wordId), ['a']);
  assert.equal(value.apply(update(4, [], { captions: [], removedCaptionIds: ['caption'] })), true);
  assert.deepEqual(value.values(), []);
});

test('invalid membership does not mutate or consume revision', () => {
  const value = state();
  value.apply(update(1, [word('a')]));
  assert.equal(value.apply(update(2, [word('b')], { removedWordIds: ['a'], captions: [
    { captionId: 'caption', captionStart: 1, wordIds: ['missing'], finalized: false },
  ] })), false);
  assert.deepEqual(value.values().map(w => w.wordId), ['a']);
  assert.equal(value.apply(update(2, [word('b')], { removedWordIds: ['a'] })), true);
});

test('finalized text/time/membership cannot change or disappear', () => {
  const value = state();
  const finalized = word('a', 'done', { provisional: false });
  value.apply(update(1, [finalized], { captions: [{ captionId: 'caption', captionStart: 1, wordIds: ['a'], finalized: true }] }));
  for (const candidate of [
    update(2, [word('a', 'wrong', { provisional: false })], { captions: [] }),
    update(2, [], { captions: [], removedWordIds: ['a'] }),
    update(2, [], { captions: [], removedCaptionIds: ['caption'] }),
  ]) assert.equal(value.apply(candidate), false);
  assert.equal(value.finalized()[0].w, 'done');
});

test('agreement prefix in open caption is not finalized history', () => {
  const value = state();
  assert.equal(value.apply(update(1, [word('a', 'agreed', { provisional: false }), word('b')])), true);
  assert.deepEqual(value.finalized(), []);
  value.setScope({ ...scope, generation: 2 });
  assert.deepEqual(value.values(), []);
  assert.equal(value.apply(update(2, [word('old')])), false);
});

test('complete finalized replay survives generations, but not source/session changes', () => {
  const value = state();
  value.mergeFinalized([word('a', 'cached', { provisional: false })]);
  value.setScope({ ...scope, generation: 2 });
  assert.equal(value.finalized().length, 1);
  value.mergeFinalized([word('a', 'bad', { provisional: false })]);
  assert.equal(value.values()[0].w, 'cached');
  value.setScope({ ...scope, sessionId: 'other' });
  assert.deepEqual(value.values(), []);
  value.mergeFinalized([word('foreign', 'bad', { sourceId: 'other', provisional: false })]);
  assert.deepEqual(value.values(), []);
});

test('malformed removals, duplicate IDs, incomplete word data are rejected', () => {
  const value = state();
  for (const candidate of [update(1, [word('a')], { removedWordIds: [42] }),
    update(1, [word('a'), word('a')]), update(1, [word('a', 'bad', { s: NaN })]),
    update(1, [word('a')], { captions: [{ captionId: 'caption', captionStart: 1, wordIds: ['a', 'a'], finalized: false }] })]) {
    assert.equal(value.apply(candidate), false);
  }
  assert.deepEqual(value.values(), []);
});
