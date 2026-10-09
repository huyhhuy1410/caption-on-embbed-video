import { test } from "node:test";
import assert from "node:assert/strict";
import { VideoDiscovery } from "../src/content/video-discovery";

// Các class tối thiểu chỉ đo lượng traversal, không mô phỏng layout/browser.
class ElementNode {
  nodeType = 1;
  isConnected = true;
  parentElement: ElementNode | null = null;
  shadowRoot = null;
  children: ElementNode[] = [];
  matches(): boolean { return false; }
  getRootNode(): unknown { return doc; }
}
class DocumentNode { nodeType = 9; }
class ShadowNode {}
class VideoNode extends ElementNode {}
let doc: DocumentNode;

test("large-tree discovery slices traversal instead of one full synchronous scan", () => {
  const original = new Map<string, unknown>();
  const names = ["Node", "Element", "HTMLVideoElement", "Document", "ShadowRoot", "NodeFilter", "MutationObserver", "document", "setTimeout", "clearTimeout"];
  for (const name of names) original.set(name, (globalThis as any)[name]);
  const queue: (() => void)[] = [];
  let walks = 0;
  const nodes = Array.from({ length: 1024 }, () => new ElementNode());
  nodes.push(new VideoNode());
  doc = new DocumentNode();
  Object.assign(doc, { createTreeWalker() {
    let index = 0;
    return { nextNode() { walks++; return nodes[index++] ?? null; } };
  } });
  Object.assign(globalThis, {
    Node: { ELEMENT_NODE: 1, DOCUMENT_NODE: 9, DOCUMENT_FRAGMENT_NODE: 11 },
    Element: ElementNode, HTMLVideoElement: VideoNode, Document: DocumentNode, ShadowRoot: ShadowNode,
    NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_REJECT: 2 }, document: doc,
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout(callback: () => void) { queue.push(callback); return queue.length; }, clearTimeout() {},
  });
  const discovery = new VideoDiscovery(() => {});
  try {
    discovery.start();
    assert.equal(walks, 0);
    queue.shift()!();
    assert.ok(walks <= 256);
    assert.equal(discovery.videos().length, 0);
    for (let i = 0; i < 10 && discovery.videos().length === 0; i++) queue.shift()!();
    assert.equal(discovery.videos().length, 1);
  } finally {
    discovery.dispose();
    for (const [name, value] of original) (globalThis as any)[name] = value;
  }
});
