import { test } from "node:test";
import assert from "node:assert/strict";
import { VideoDiscovery } from "../src/content/video-discovery";
import { bindVideoEvents } from "../src/content/video-events";
import { CaptionFullscreen } from "../src/content/fullscreen";
import { VideoPicker } from "../src/content/video-picker";

// DOM double kiểm tra ownership/lifecycle; fullscreen top layer thật vẫn cần browser gate.
class FakeNode extends EventTarget {
  static ELEMENT_NODE = 1;
  static DOCUMENT_NODE = 9;
  static DOCUMENT_FRAGMENT_NODE = 11;
  children: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  nodeType = 1;
  get isConnected(): boolean { return this instanceof FakeDocument || !!this.parentNode?.isConnected; }
  get parentElement(): FakeElement | null { return this.parentNode instanceof FakeElement ? this.parentNode : null; }
  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  getRootNode(): FakeNode { return this.parentNode?.getRootNode() ?? this; }
  insertBefore(node: FakeNode, before: FakeNode | null): FakeNode {
    node.remove();
    node.parentNode = this;
    const index = before ? this.children.indexOf(before) : -1;
    this.children.splice(index < 0 ? this.children.length : index, 0, node);
    return node;
  }
  appendChild(node: FakeNode): FakeNode { return this.insertBefore(node, null); }
  append(...nodes: FakeNode[]): void { nodes.forEach((node) => this.appendChild(node)); }
  remove(): void {
    if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
}
class FakeElement extends FakeNode {
  shadowRoot: FakeShadow | null = null;
  dataset: Record<string, string> = {};
  style = { cssText: "", width: "", height: "", display: "" };
  attrs = new Map<string, string>();
  localName: string;
  className = "";
  private text = "";
  get textContent(): string { return this.text; }
  set textContent(value: string) {
    this.text = value;
    for (const child of [...this.children]) child.remove();
  }
  offsetWidth = 100;
  offsetHeight = 50;
  constructor(name = "div") { super(); this.localName = name; }
  attachShadow(): FakeShadow { this.shadowRoot = new FakeShadow(this); return this.shadowRoot; }
  matches(selector: string): boolean {
    return selector === "[data-caption-ai-owned]" ? this.dataset.captionAiOwned !== undefined :
      selector.startsWith(".") ? this.className === selector.slice(1) : this.localName === selector;
  }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  getAttribute(name: string): string | null { return name === "data-index" ? this.dataset.index ?? null : this.attrs.get(name) ?? null; }
  removeAttribute(name: string): void { this.attrs.delete(name); }
  querySelectorAll(selector: string): FakeElement[] {
    return this.children.flatMap((child) => child instanceof FakeElement ?
      [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)] : []);
  }
  querySelector(selector: string): FakeElement | null { return this.querySelectorAll(selector)[0] ?? null; }
  getBoundingClientRect() { return { left: 0, top: 0, bottom: 50, width: 100, height: 50 }; }
  focus(): void {}
  async requestFullscreen(): Promise<void> {
    (this.getRootNode() as FakeDocument | FakeShadow).fullscreenElement = this;
    this.dispatchEvent(new Event("fullscreenchange"));
  }
}
class FakeVideo extends FakeElement {
  videoWidth = 100;
  videoHeight = 50;
  paused = true;
  ended = false;
  currentSrc = "";
  src = "";
  constructor() { super("video"); }
}
class FakeShadow extends FakeNode {
  nodeType = 11;
  fullscreenElement: FakeElement | null = null;
  constructor(readonly host: FakeElement) { super(); }
  get isConnected(): boolean { return this.host.isConnected; }
}
class FakeDocument extends FakeNode {
  nodeType = 9;
  fullscreenElement: FakeElement | null = null;
  body = new FakeElement("body");
  constructor() { super(); this.appendChild(this.body); }
  createElement(name: string) { return name === "video" ? new FakeVideo() : new FakeElement(name); }
  createTreeWalker(root: FakeNode, _what: number, filter: { acceptNode(node: FakeElement): number }) {
    const queue = [...root.children];
    return { nextNode() {
      while (queue.length) {
        const node = queue.shift()!;
        if (!(node instanceof FakeElement) || filter.acceptNode(node) === 2) continue;
        queue.unshift(...node.children);
        return node;
      }
      return null;
    } };
  }
  async exitFullscreen() { this.fullscreenElement = null; this.dispatchEvent(new Event("fullscreenchange")); }
}
class FakeObserver {
  static instances: FakeObserver[] = [];
  active = true;
  constructor(readonly callback: (records: any[]) => void) { FakeObserver.instances.push(this); }
  observe(): void {}
  disconnect(): void { this.active = false; }
}
function environment(): FakeDocument {
  FakeObserver.instances = [];
  const document = new FakeDocument();
  const window = Object.assign(new EventTarget(), { innerWidth: 800, innerHeight: 600, location: { href: "https://example.test/" } });
  Object.assign(globalThis, {
    Node: FakeNode, Element: FakeElement, HTMLVideoElement: FakeVideo, Document: FakeDocument,
    ShadowRoot: FakeShadow, MutationObserver: FakeObserver, NodeFilter: { SHOW_ELEMENT: 1, FILTER_REJECT: 2, FILTER_ACCEPT: 1 },
    document, window, DOMRect: class { constructor(public x: number, public y: number, public width: number, public height: number) {} },
  });
  return document;
}
const asVideo = (video: FakeVideo) => video as unknown as HTMLVideoElement;
const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
function overlay(document: FakeDocument) {
  const element = new FakeElement();
  element.attachShadow();
  document.body.appendChild(element);
  return { element, position() {}, resetToVideoAnchor() {}, mountToolbarButton(button: FakeNode) { element.shadowRoot!.appendChild(button); } };
}

test("direct media bindings work without composed events and dispose idempotently", () => {
  const video = new EventTarget();
  let calls = 0;
  const dispose = bindVideoEvents(video as HTMLVideoElement, { pause: () => calls++, play: undefined });
  video.dispatchEvent(new Event("pause"));
  dispose(); dispose();
  video.dispatchEvent(new Event("pause"));
  assert.equal(calls, 1);
});

test("discovery finds nested/dynamic/late roots, ignores owned UI and disconnects", async () => {
  const document = environment();
  const host = new FakeElement();
  document.body.appendChild(host);
  const nested = new FakeElement();
  host.attachShadow().appendChild(nested);
  const first = new FakeVideo();
  nested.attachShadow().appendChild(first);
  const ignored = new FakeElement();
  ignored.dataset.captionAiOwned = "true";
  ignored.attachShadow().appendChild(new FakeVideo());
  document.body.appendChild(ignored);
  const lateHost = new FakeElement();
  document.body.appendChild(lateHost);
  let changes = 0;
  const discovery = new VideoDiscovery(() => changes++);
  discovery.start(); discovery.start();
  await wait();
  assert.deepEqual(discovery.videos(), [first]);
  const lateVideo = new FakeVideo();
  lateHost.attachShadow().appendChild(lateVideo);
  await wait(300);
  assert.deepEqual(discovery.videos(), [first, lateVideo]);
  const dynamicHost = new FakeElement();
  const dynamicVideo = new FakeVideo();
  dynamicHost.attachShadow().appendChild(dynamicVideo);
  document.body.appendChild(dynamicHost);
  FakeObserver.instances[0].callback([{ type: "childList", target: document.body, addedNodes: [dynamicHost], removedNodes: [] }]);
  await wait();
  assert.ok(discovery.videos().includes(asVideo(dynamicVideo)));
  host.remove();
  FakeObserver.instances[0].callback([{ type: "childList", target: document.body, addedNodes: [], removedNodes: [host] }]);
  await wait();
  assert.ok(!discovery.videos().includes(asVideo(first)));
  assert.ok(FakeObserver.instances.some((observer) => !observer.active));
  assert.ok(changes >= 3);
  discovery.dispose(); discovery.dispose();
  assert.equal(discovery.videos().length, 0);
  assert.ok(FakeObserver.instances.every((observer) => !observer.active));
});

test("ESC restores exact sibling/style; removed wrapper never resurrects video", async () => {
  const document = environment();
  const video = new FakeVideo();
  video.style.cssText = "color:red";
  const sibling = new FakeElement();
  document.body.append(video, sibling);
  const captions = overlay(document);
  const fullscreen = new CaptionFullscreen();
  fullscreen.setTarget(asVideo(video), captions as any);
  await fullscreen.enter();
  assert.equal(fullscreen.isActive(), true);
  await document.exitFullscreen();
  assert.equal(fullscreen.isActive(), false);
  assert.equal(video.nextSibling, sibling);
  assert.equal(video.style.cssText, "color:red");
  await fullscreen.enter();
  video.parentNode!.remove();
  fullscreen.recoverIfBroken();
  assert.equal(video.isConnected, false);
  assert.equal(captions.element.parentNode, document.body);
  fullscreen.dispose();
});

test("shadow fullscreen uses root ownership and target switches restore old video", async () => {
  const document = environment();
  const host = new FakeElement();
  document.body.appendChild(host);
  const root = host.attachShadow();
  const oldVideo = new FakeVideo();
  const nextVideo = new FakeVideo();
  root.appendChild(oldVideo);
  document.body.appendChild(nextVideo);
  const captions = overlay(document);
  const fullscreen = new CaptionFullscreen();
  fullscreen.setTarget(asVideo(oldVideo), captions as any);
  await fullscreen.enter();
  assert.equal(fullscreen.isActive(), true);
  fullscreen.setTarget(asVideo(nextVideo), captions as any);
  assert.equal(oldVideo.parentNode, root);
  assert.equal(nextVideo.parentNode, document.body);
  assert.equal(fullscreen.isActive(), false);
  fullscreen.dispose();
});

test("SPA taking video away does not move it back or overwrite new style", async () => {
  const document = environment();
  const video = new FakeVideo();
  document.body.appendChild(video);
  const captions = overlay(document);
  const fullscreen = new CaptionFullscreen();
  fullscreen.setTarget(asVideo(video), captions as any);
  await fullscreen.enter();
  const newParent = new FakeElement();
  document.body.appendChild(newParent);
  newParent.appendChild(video);
  video.style.cssText = "width:42px";
  fullscreen.recoverIfBroken();
  assert.equal(video.parentNode, newParent);
  assert.equal(video.style.cssText, "width:42px");
  fullscreen.dispose();
});

test("request rejection and stale promise rejection cannot leave or destroy sessions", async () => {
  const document = environment();
  const video = new FakeVideo();
  document.body.appendChild(video);
  const captions = overlay(document);
  const fullscreen = new CaptionFullscreen();
  fullscreen.setTarget(asVideo(video), captions as any);
  let rejectOld: ((error: Error) => void) | undefined;
  const request = FakeElement.prototype.requestFullscreen;
  FakeElement.prototype.requestFullscreen = function () {
    return new Promise<void>((_resolve, reject) => { rejectOld = reject; });
  };
  const oldEnter = fullscreen.enter();
  fullscreen.dispose();
  FakeElement.prototype.requestFullscreen = request;
  fullscreen.setTarget(asVideo(video), captions as any);
  await fullscreen.enter();
  const oldWarn = console.warn;
  console.warn = () => {};
  try {
    rejectOld!(new Error("denied"));
    await oldEnter;
    assert.equal(fullscreen.isActive(), true);
    fullscreen.dispose();
    FakeElement.prototype.requestFullscreen = async () => { throw new Error("denied"); };
    fullscreen.setTarget(asVideo(video), captions as any);
    await fullscreen.enter();
    assert.equal(fullscreen.isActive(), false);
    assert.equal(video.parentNode, document.body);
  } finally {
    console.warn = oldWarn;
    FakeElement.prototype.requestFullscreen = request;
    fullscreen.dispose();
  }
});

test("SPA removing original parent or video never restores removed content", async () => {
  const document = environment();
  const parent = new FakeElement();
  const video = new FakeVideo();
  document.body.appendChild(parent);
  parent.appendChild(video);
  const captions = overlay(document);
  const fullscreen = new CaptionFullscreen();
  fullscreen.setTarget(asVideo(video), captions as any);
  await fullscreen.enter();
  parent.remove();
  fullscreen.recoverIfBroken();
  assert.equal(video.isConnected, false);
  assert.equal(fullscreen.isActive(), false);
  document.body.appendChild(parent);
  parent.appendChild(video);
  fullscreen.setTarget(asVideo(video), captions as any);
  await fullscreen.enter();
  video.remove();
  fullscreen.recoverIfBroken();
  assert.equal(video.parentNode, null);
  assert.equal(fullscreen.isActive(), false);
  fullscreen.dispose();
});

test("picker replaces shadow-video references, refreshes src and rejects stale picks", () => {
  const document = environment();
  const host = new FakeElement();
  document.body.appendChild(host);
  const root = host.attachShadow();
  const first = new FakeVideo();
  const second = new FakeVideo();
  const replacement = new FakeVideo();
  root.append(first, second, replacement);
  const captions = overlay(document);
  const picks: FakeVideo[] = [];
  const picker = new VideoPicker(captions.element as any, (video) => picks.push(video as any));
  picker.setVideos([asVideo(first), asVideo(second)]);
  const state = picker as any;
  const staleItem = state.list.children[1];
  picker.setVideos([asVideo(first), asVideo(replacement)]);
  staleItem.dispatchEvent(new Event("click"));
  assert.equal(picks.length, 0);
  state.list.children[1].dispatchEvent(new Event("click"));
  assert.equal(picks[0], replacement);
  replacement.src = "https://example.test/new.mp4";
  picker.setVideos([asVideo(first), asVideo(replacement)]);
  assert.equal(state.list.children[1].querySelector(".name").textContent, "new.mp4");
  picker.dispose();
});
