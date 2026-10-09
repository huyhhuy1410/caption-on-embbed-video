import { test } from "node:test";
import assert from "node:assert/strict";
import { SourceIdentity } from "../src/content/source-identity";

const page = "https://example.test/watch";
const video = (name: string) => ({ currentSrc: `https://example.test/${name}.mp4`, src: "" });

test("independent documents cannot share a backend source namespace", () => {
  const firstDocument = new SourceIdentity();
  const secondDocument = new SourceIdentity();
  assert.notEqual(firstDocument.forVideo(video("A"), page), secondDocument.forVideo(video("B"), page));
  assert.notEqual(new SourceIdentity().forVideo(video("A"), page), new SourceIdentity().forVideo(video("A"), page));
});

test("source allocation works on HTTP without secure-context randomUUID", (context) => {
  context.mock.method(crypto, "randomUUID", () => { throw new Error("secure context required"); });
  const id = new SourceIdentity().forVideo(video("A"), "http://example.test/watch");
  assert.match(id, /^[a-f0-9]{32}:v1$/);
});

test("unchanged media keeps identity across repeated resolution and A to B to A selection", () => {
  const sources = new SourceIdentity();
  const a = video("A");
  const b = video("B");
  const id = sources.forVideo(a, page);
  assert.equal(sources.forVideo(a, page), id);
  assert.notEqual(sources.forVideo(b, page), id);
  assert.equal(sources.forVideo(a, page), id);
});

test("media or SPA page changes allocate a new source even with the same element", () => {
  const sources = new SourceIdentity();
  const a = video("A");
  const first = sources.forVideo(a, page);
  a.currentSrc = video("B").currentSrc;
  const second = sources.forVideo(a, page);
  assert.notEqual(second, first);
  assert.notEqual(sources.forVideo(a, `${page}?id=next`), second);
});

test("loadstart and emptied invalidation create new incarnations without affecting other videos", () => {
  const sources = new SourceIdentity();
  const a = video("A");
  const b = video("B");
  const first = sources.forVideo(a, page);
  const other = sources.forVideo(b, page);
  sources.invalidate(a);
  const loaded = sources.forVideo(a, page);
  assert.notEqual(loaded, first);
  sources.invalidate(a);
  assert.notEqual(sources.forVideo(a, page), loaded);
  assert.equal(sources.forVideo(b, page), other);
});
