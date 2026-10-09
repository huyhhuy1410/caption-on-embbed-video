import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

async function loadModule(relative) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(relative, import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18',
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

const { serializeTranscript } = await loadModule('../src/content/transcript-export.ts');
const { SnapshotStore, durableVideoKey } = await loadModule('../src/shared/snapshot-store.ts');
const URL_A = 'https://example.test/video?id=one';
const URL_B = 'https://example.test/video?id=two';
const URL_C = 'https://example.test/video?id=three';
const word = (w = 'Hello', start = 1, extra = {}) => ({
  w, s: 0, e: 0.5, videoStart: start, videoEnd: start + 0.5, captionStart: start, c: 0.9, ...extra,
});
const translation = (start = 1, extra = {}) => ({ captionStart: start, text: 'Hello', vi: 'Xin chào Việt Nam', ...extra });
const snapshot = (words = [word()], translations = [translation()], savedAt = 100) => ({ version: 1, savedAt, words, translations });

class MemoryStorage {
  data = {};
  sets = 0;
  active = 0;
  peak = 0;
  fail = false;
  async get(key) {
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    const result = structuredClone(this.data);
    this.active--;
    return { [key]: result[key] };
  }
  async set(items) {
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    this.active--;
    if (this.fail) { this.fail = false; throw new Error('quota rejected'); }
    this.sets++;
    Object.assign(this.data, structuredClone(items));
  }
  entries() { return Object.values(this.data)[0]?.entries ?? []; }
}
const storeFixture = (options = {}) => {
  const storage = new MemoryStorage();
  let now = 100;
  const store = new SnapshotStore(storage, { now: () => now, ...options });
  return { storage, store, tick: (value) => { now = value; } };
};

test('SRT sorts watched history, joins caption words, and preserves bilingual Unicode', () => {
  const words = [word('later', 3700), word('world!', 1.5, { captionStart: 1 }), word('Hello', 1)];
  assert.equal(serializeTranscript('srt', words, [translation()]),
    '1\n00:00:01,000 --> 00:00:02,000\nHello world!\nXin chào Việt Nam\n\n2\n01:01:40,000 --> 01:01:40,500\nlater\n');
});

test('VTT uses header and millisecond dot; TXT keeps plain Unicode and bilingual rows', () => {
  assert.equal(serializeTranscript('vtt', [word()], [translation()]),
    'WEBVTT\n\n1\n00:00:01.000 --> 00:00:01.500\nHello\nXin chào Việt Nam\n');
  assert.equal(serializeTranscript('txt', [word()], [translation()]), 'Hello\nXin chào Việt Nam\n');
  assert.equal(serializeTranscript('vtt', [], []), 'WEBVTT\n\n');
  assert.equal(serializeTranscript('srt', [], []), '');
  assert.equal(serializeTranscript('txt', [], []), '');
});

test('provisional and unspecified streaming finalization exclude the whole caption', () => {
  const stable = { sourceId: 'v1', captionId: 'c1', provisional: false };
  const words = [word('final prefix', 1, { ...stable, wordId: 'w1' }),
    word('tail', 1.5, { ...stable, wordId: 'w2', provisional: true }),
    word('unknown', 3, { captionId: 'c2', wordId: 'w3' }), word('legacy', 4)];
  assert.equal(serializeTranscript('txt', words, [translation(1, stable)]), 'legacy\n');
});

test('streaming identity deduplicates IDs, preserves real repeated words and separates sources', () => {
  const stable = { sourceId: 'v1', captionId: 'c1', provisional: false };
  const words = [word('old', 1, { ...stable, wordId: 'w1' }),
    word('go', 1, { ...stable, wordId: 'w1' }), word('go', 1.5, { ...stable, wordId: 'w2' }),
    word('other', 1, { ...stable, sourceId: 'v2', wordId: 'w1' })];
  assert.equal(serializeTranscript('txt', words, [translation(999, stable)]),
    'other\n\ngo go\nXin chào Việt Nam\n');
});

test('invalid timing is excluded, rounded zero-duration cues gain one millisecond', () => {
  const words = [word('bad', -1), word('bad', NaN), word('bad', 2, { videoEnd: 1 }),
    word('valid', 59.9996, { videoEnd: 60.0001 })];
  assert.equal(serializeTranscript('srt', words, []), '1\n00:01:00,000 --> 00:01:00,001\nvalid\n');
  assert.throws(() => serializeTranscript('html', [], []), /Unsupported/);
});

test('subtitle text cannot inject tags, new cues or timing lines', () => {
  assert.equal(serializeTranscript('vtt', [word('<b>A & B</b>\n\n1 --> 2')], []),
    'WEBVTT\n\n1\n00:00:01.000 --> 00:00:01.500\n&lt;b&gt;A &amp; B&lt;/b&gt; 1 —&gt; 2\n');
  assert.equal(serializeTranscript('txt', [word('<b>plain</b>')], []), '<b>plain</b>\n');
});

test('durable key retains query identity and removes only fragment', () => {
  assert.equal(durableVideoKey(`${URL_A}#t=3`), URL_A);
  assert.notEqual(durableVideoKey(URL_A), durableVideoKey(URL_B));
  assert.equal(durableVideoKey('https://example.test/a?v=123&quality=hd'), 'https://example.test/a?v=123&quality=hd');
});

test('durable key rejects unknown, credential-bearing, signed and unstable URLs', () => {
  for (const url of ['blob:https://example.test/abc', 'data:video/mp4;base64,a', 'file:///a.mp4', '/relative', '',
    'https://user:pass@example.test/a', `${URL_A}&token=abc`, `${URL_A}&X-Amz-Signature=abc`,
    `${URL_A}&expires=123`, `${URL_A}&hdnts=abc`, `${URL_A}&live=1`, `${URL_A}&sessionId=123`]) {
    assert.equal(durableVideoKey(url), null, url);
  }
});

test('round-trip separates two video identities and strips unknown fields', async () => {
  const { store, storage } = storeFixture();
  const data = snapshot([word('Hello', 1, { audio: 'PCM', apiKey: 'not-real' })]);
  data.apiKey = 'not-real';
  await store.save(URL_A, data);
  await store.save(URL_B, snapshot([word('second')], []));
  assert.equal((await store.load(URL_A)).words[0].w, 'Hello');
  assert.equal((await store.load(URL_B)).words[0].w, 'second');
  assert.ok(!JSON.stringify(storage.data).includes('PCM'));
  assert.ok(!JSON.stringify(storage.data).includes('apiKey'));
  const loaded = await store.load(URL_A);
  loaded.words[0].w = 'mutated';
  assert.equal((await store.load(URL_A)).words[0].w, 'Hello');
});

test('snapshot excludes partial captions and orphan translations', async () => {
  const { store } = storeFixture();
  const stable = { sourceId: 'v1', captionId: 'c1', provisional: false };
  await store.save(URL_A, snapshot([
    word('prefix', 1, stable), word('tail', 1.5, { ...stable, provisional: true }), word('legacy', 3),
  ], [translation(1, stable), translation(3), translation(99)]));
  const restored = await store.load(URL_A);
  assert.deepEqual(restored.words.map((item) => item.w), ['legacy']);
  assert.deepEqual(restored.translations.map((item) => item.captionStart), [3]);
});

test('snapshot explicit finalized streaming and capture mapping round-trip', async () => {
  const { store } = storeFixture();
  const ids = { sourceId: 'v1', captionId: 'c1', wordId: 'w1', provisional: false, capturedAtEpochMs: 123456 };
  await store.save(URL_A, snapshot([word('hello', 1, ids)], [translation(1, ids)]));
  const restored = await store.load(URL_A);
  assert.deepEqual(restored.words[0], word('hello', 1, ids));
  assert.equal(restored.translations[0].captionId, 'c1');
  assert.equal(restored.translations[0].wordId, undefined);
});

test('TTL expiry is based on save time, not a read touch', async () => {
  const { store, storage, tick } = storeFixture({ ttlMs: 20 });
  await store.save(URL_A, snapshot());
  tick(119);
  assert.ok(await store.load(URL_A));
  tick(120);
  assert.equal(await store.load(URL_A), null);
  assert.equal(storage.entries().length, 0);
});

test('LRU cap evicts least recently loaded video', async () => {
  const { store, storage, tick } = storeFixture({ maxEntries: 2 });
  await store.save(URL_A, snapshot());
  tick(101); await store.save(URL_B, snapshot());
  tick(102); await store.load(URL_A);
  tick(103); await store.save(URL_C, snapshot());
  assert.equal(await store.load(URL_B), null);
  assert.ok(await store.load(URL_A));
  assert.ok(await store.load(URL_C));
  assert.equal(storage.entries().length, 2);
});

test('byte cap counts UTF-8 JSON plus storage key and evicts oldest entries', async () => {
  const { store, storage, tick } = storeFixture({ maxBytes: 550 });
  await store.save(URL_A, snapshot());
  tick(101); await store.save(URL_B, snapshot());
  assert.ok(Buffer.byteLength(JSON.stringify(Object.values(storage.data)[0])) + Buffer.byteLength(Object.keys(storage.data)[0]) <= 550);
  assert.equal(await store.load(URL_A), null);
  assert.ok(await store.load(URL_B));
});

test('oversized and malformed saves reject instead of poisoning storage', async () => {
  const { store, storage } = storeFixture({ maxSnapshotBytes: 300 });
  await assert.rejects(store.save(URL_A, snapshot([word('x'.repeat(1000))])), /byte cap/);
  for (const data of [null, { ...snapshot(), version: 2 }, snapshot([word('bad', 1, { c: NaN })]),
    snapshot([word('bad', 1, { provisional: 'false' })]), snapshot([], [], 101)]) {
    await assert.rejects(store.save(URL_A, data), /Invalid transcript snapshot/);
  }
  assert.equal(storage.sets, 0);
});

test('untrusted storage invalid entries are removed; future/expired timestamps cannot restore', async () => {
  const { store, storage } = storeFixture();
  await store.save(URL_A, snapshot());
  const bucket = Object.values(storage.data)[0];
  bucket.entries.push(
    { key: URL_B, lastAccess: 100, snapshot: snapshot([word('bad', 1, { videoEnd: Infinity })]) },
    { key: URL_C, lastAccess: 101, snapshot: snapshot() },
    { key: 'blob:https://example.test/a', lastAccess: 100, snapshot: snapshot() },
  );
  assert.ok(await store.load(URL_A));
  assert.equal(storage.entries().length, 1);
  Object.values(storage.data)[0].entries[0].snapshot.savedAt = 101;
  assert.equal(await store.load(URL_A), null);
});

test('corrupt storage envelopes and excessive arrays safely miss', async () => {
  const { store, storage } = storeFixture();
  await store.save(URL_A, snapshot());
  const key = Object.keys(storage.data)[0];
  for (const value of [null, [], { version: 2, entries: [] }, { version: 1, entries: Array(1001).fill(null) }]) {
    storage.data[key] = value;
    assert.equal(await store.load(URL_A), null);
  }
});

test('concurrent instances serialize read-modify-write operations and preserve both videos', async () => {
  const { store, storage } = storeFixture();
  const other = new SnapshotStore(storage, { now: () => 100 });
  const data = snapshot();
  const first = store.save(URL_A, data);
  data.words[0].w = 'mutation after save';
  await Promise.all([first, other.save(URL_B, snapshot([word('two')]))]);
  assert.equal((await store.load(URL_A)).words[0].w, 'Hello');
  assert.ok(await store.load(URL_B));
  assert.equal(storage.peak, 1);
});

test('storage failure surfaces and does not block subsequent queued writes', async () => {
  const { store, storage } = storeFixture();
  storage.fail = true;
  const failed = store.save(URL_A, snapshot());
  const successful = store.save(URL_B, snapshot());
  await assert.rejects(failed, /quota rejected/);
  await successful;
  assert.ok(await store.load(URL_B));
});

test('session-only sources never access storage; empty finalized history clears old snapshot', async () => {
  const { store, storage } = storeFixture();
  await store.save('blob:https://example.test/a', null);
  assert.equal(await store.load('blob:https://example.test/a'), null);
  assert.equal(storage.sets, 0);
  await store.save(URL_A, snapshot());
  await store.save(URL_A, snapshot([]));
  assert.equal(await store.load(URL_A), null);
});
