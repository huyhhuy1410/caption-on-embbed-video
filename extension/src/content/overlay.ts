import { applyPatch, groupWords } from "../shared/windowed-transcript";
import type { WindowedPatch } from "../shared/windowed-transcript";
import { captionKey, TranscriptState, validWord } from "../shared/transcript-state";
import type { CaptureScope, WordsUpdate, CaptionWord, SentenceTranslation } from "../shared/protocol";
export type { CaptionWord, SentenceTranslation } from "../shared/protocol";

// Word the user clicked, with its sentence — `/explain-word` needs context
// to disambiguate video meaning from dictionary meaning.
export interface WordPick {
  word: string;
  context: string;
  anchor: { left: number; top: number; right: number; bottom: number };
}

// Caption line colors (FR-4.9).
export interface CaptionColors {
  en: string;
  vi: string;
}

type CaptionColorKey = keyof CaptionColors;

// EN is primary; VI is deliberately subdued to avoid competing for attention.
const DEFAULT_COLORS: CaptionColors = {
  en: "#ffffff",
  vi: "#9e9e9e",
};

// Panel beside video, not overlaid — overlay would obscure most of the frame.
const PANEL_GAP_PX = 12;
const PANEL_WIDTH_PX = 320;

// Max panel width after user drags (px).
const DRAGGED_MAX_WIDTH_PX = 560;

// Keep at least this much of panel (px) in viewport when dragging.
// Overlay is `position: fixed` with no other UI to recall it — losing it
// entirely means F5 is the only recovery.
const KEEP_VISIBLE_PX = 48;

// Normalized caption group derived from `words[]`.
interface CaptionGroup {
  key: string;
  words: CaptionWord[];
  signature: string;
}

// Caption line rendered in DOM.
interface RenderedLine {
  key: string;
  wrapper: HTMLDivElement;
  en: HTMLDivElement;
  vi: HTMLDivElement;
  spans: HTMLSpanElement[];
  signature: string;
  words: CaptionWord[];
}

/** Visual anchor of the first line being read — preserves manual scroll across DOM updates. */
interface ScrollAnchor {
  key: string;
  offset: number;
}

export class CaptionOverlay {
  private host: HTMLDivElement;
  private shadow: ShadowRoot;
  private lineHost: HTMLDivElement;
  private dragHandle: HTMLDivElement;
  private followButton: HTMLButtonElement;
  private toolbar: HTMLDivElement;
  private settingsButton: HTMLButtonElement;
  private settingsMenu: HTMLDivElement;
  private words: CaptionWord[] = [];
  private readonly transcript = new TranscriptState();
  private readonly firstRendered = new Set<string>();
  private readonly finalizedRendered = new Set<string>();
  private metricFramePending = false;
  private translationHistory = new Map<string, SentenceTranslation>();
  private translations = new Map<string, string>();
  private readonly colorInputs = new Map<CaptionColorKey, HTMLInputElement>();
  private wordPick: ((pick: WordPick) => void) | null = null;
  private userPositioned = false;
  private drag: {
    pointerId: number;
    startX: number;
    startY: number;
    originLeft: number;
    originTop: number;
  } | null = null;
  private colors: CaptionColors = { ...DEFAULT_COLORS };
  private renderedLines: RenderedLine[] = [];
  private readonly renderedByKey = new Map<string, RenderedLine>();
  private activeKey: string | null = null;
  private activeWordIndex = -1;
  private lastVideoTime = 0;

  /** Whether scrolling manually or auto-scrolling with current sentence. */
  private autoScroll = true;

  /** Caption groups model, only rebuilt when `setWords()` changes data. */
  private groups: CaptionGroup[] = [];
  private groupsDirty = true;

  private readonly onDocumentPointerDown = (event: Event): void => {
    if (this.settingsMenu.hidden) return;
    if (event.composedPath().includes(this.settingsMenu)) return;
    if (event.composedPath().includes(this.settingsButton)) return;
    this.settingsMenu.hidden = true;
  };

  constructor() {
    this.host = document.createElement("div");
    this.host.dataset.captionAiOwned = "";
    this.shadow = this.host.attachShadow({ mode: "open" });
    this.lineHost = document.createElement("div");
    this.dragHandle = document.createElement("div");
    this.followButton = document.createElement("button");
    this.toolbar = document.createElement("div");
    this.settingsButton = document.createElement("button");
    this.settingsMenu = document.createElement("div");
    this.dragHandle.className = "drag-handle";

    const style = document.createElement("style");
    style.textContent = `
:host {
  position: fixed;
  z-index: 99999999;
  /* Pass-through: page (incl. video controls/seek) must remain clickable.
     Children opt in with their own pointer-events. */
  pointer-events: none;
  display: flex;
  flex-direction: column;
  font-family: system-ui, sans-serif;
  box-sizing: border-box;
}
/* HTML hidden is just UA display:none, so author display rules override it.
   .settings-menu has display:grid, so toggling gear twice didn't hide it (Issue 5.39). */
[hidden] {
  display: none !important;
}
.drag-handle {
  pointer-events: auto;
  cursor: move;
  height: 12px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.14);
  flex: 0 0 auto;
  touch-action: none;
}
.drag-handle:hover {
  background: rgba(255, 255, 255, 0.28);
}
.panel {
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  background: rgba(0, 0, 0, 0.78);
  border-radius: 8px;
  padding: 8px;
  gap: 6px;
  width: ${PANEL_WIDTH_PX}px;
  max-width: 90vw;
  max-height: 70vh;
  min-height: 120px;
}
/* Scroll area — overflow-y enables scrollbar when content exceeds frame. */
.lines {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: 8px;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.35) transparent;
}
.lines::-webkit-scrollbar {
  width: 6px;
}
.lines::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.35);
  border-radius: 3px;
}
.line {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 0 0 auto;
}
.line-en {
  color: var(--en);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.35;
  text-align: left;
  cursor: pointer;
}
.line-vi {
  color: var(--vi);
  font-size: 12.5px;
  line-height: 1.3;
  text-align: left;
}
.line-past {
  opacity: 0.55;
}
.line-past .line-en {
  font-size: 13px;
  font-weight: 500;
}
.line-past .line-vi {
  font-size: 11.5px;
}
.line-active {
  opacity: 1;
}
.line-active .line-en {
  font-size: 15px;
}
.word-picked {
  color: #ffd84d;
  text-decoration: underline;
}
.line-en span {
  opacity: 0.62;
  transition: opacity 100ms ease, font-weight 100ms ease;
}
.word-active {
  opacity: 1 !important;
  font-weight: 800;
}
.toolbar {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
  flex: 0 0 auto;
  border-top: 1px solid rgba(255, 255, 255, 0.12);
  padding-top: 6px;
}
.toolbar > * {
  pointer-events: auto;
}
.settings-menu {
  position: absolute;
  right: 0;
  bottom: calc(100% + 6px);
  display: grid;
  gap: 7px;
  min-width: 170px;
  padding: 9px;
  background: rgba(16, 16, 18, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 7px;
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.4);
}
.color-control {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: #cfcfcf;
  font-size: 10px;
  line-height: 1;
  white-space: nowrap;
}
button {
  font: inherit;
  font-size: 11px;
  color: #ddd;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 5px;
  padding: 4px 8px;
  cursor: pointer;
}
button:hover {
  background: rgba(255, 255, 255, 0.2);
}
/* "Follow current" only shows during manual scroll — redundant under auto-scroll. */
button.follow {
  margin-right: auto;
  background: rgba(79, 195, 247, 0.22);
  border-color: #4fc3f7;
  color: #fff;
}
button.icon-button {
  width: 28px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  font-size: 15px;
}
/* input[type=color] has thick UA border by default — strip it. */
input[type="color"] {
  width: 24px;
  height: 20px;
  padding: 1px;
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  cursor: pointer;
}
`;

    this.host.style.setProperty("--en", this.colors.en);
    this.host.style.setProperty("--vi", this.colors.vi);

    const panel = document.createElement("div");
    panel.className = "panel";

    this.toolbar.className = "toolbar";
    this.settingsMenu.className = "settings-menu";
    this.settingsMenu.hidden = true;
    this.settingsMenu.append(
      this.makeColorControl("en", "English", this.colors.en),
      this.makeColorControl("vi", "Translation", this.colors.vi),
    );

    this.settingsButton.type = "button";
    this.settingsButton.className = "icon-button";
    this.settingsButton.textContent = "⚙";
    this.settingsButton.title = "Caption settings";
    this.settingsButton.setAttribute("aria-label", "Caption settings");
    this.settingsButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.settingsMenu.hidden = !this.settingsMenu.hidden;
    });

    this.followButton.className = "follow";
    this.followButton.textContent = "Follow current";
    this.followButton.hidden = true;
    this.followButton.addEventListener("click", () => {
      this.autoScroll = true;
      this.followButton.hidden = true;
      this.scrollToCurrent();
    });
    this.toolbar.append(
      this.followButton,
      this.settingsMenu,
      this.settingsButton,
    );

    panel.appendChild(this.lineHost);
    panel.appendChild(this.toolbar);
    this.lineHost.className = "lines";

    this.shadow.appendChild(style);
    this.shadow.appendChild(this.dragHandle);
    this.shadow.appendChild(panel);
    document.addEventListener("pointerdown", this.onDocumentPointerDown, true);

    this.lineHost.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const keyRaw = target.getAttribute("data-caption-key");
      const indexRaw = target.getAttribute("data-index");
      if (keyRaw === null || indexRaw === null) return;
      const key = keyRaw;
      const index = Number(indexRaw);
      if (!Number.isInteger(index)) return;
      const pick = this.pickAt(key, index);
      if (pick) {
        const rect = target.getBoundingClientRect();
        this.wordPick?.({
          ...pick,
          anchor: {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
          },
        });
      }
    });

    // Only real user input triggers manual scroll. `scroll` event is not used:
    // Chrome fires it when new rows/VI change height (scroll anchoring),
    // which would stop auto-scroll without user intent.
    this.lineHost.addEventListener("scroll", () => this.measureFirstRender(), { passive: true });
    this.lineHost.tabIndex = 0;
    this.lineHost.addEventListener("wheel", () => this.switchToManualScroll(), {
      passive: true,
    });
    this.lineHost.addEventListener(
      "touchmove",
      () => this.switchToManualScroll(),
      { passive: true },
    );
    this.lineHost.addEventListener("keydown", (event) => {
      if (
        ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(
          event.key,
        )
      ) {
        this.switchToManualScroll();
      }
    });
    this.lineHost.addEventListener("pointerdown", (event) => {
      // Scrollbar drag doesn't fire wheel; detect scrollbar area at right edge.
      const rect = this.lineHost.getBoundingClientRect();
      if (event.clientX >= rect.right - 12) this.switchToManualScroll();
    });

    this.installDrag();

    document.body.appendChild(this.host);
    this.hide();
  }

  private makeColorControl(
    key: CaptionColorKey,
    label: string,
    value: string,
  ): HTMLLabelElement {
    const wrapper = document.createElement("label");
    wrapper.className = "color-control";
    wrapper.textContent = label;
    const input = document.createElement("input");
    input.type = "color";
    input.value = value;
    input.dataset.colorKey = key;
    input.title = `${label} color`;
    input.setAttribute("aria-label", `${label} color`);
    input.addEventListener("input", () => {
      this.setColors({ [key]: input.value });
    });
    this.colorInputs.set(key, input);
    wrapper.appendChild(input);
    return wrapper;
  }

  private installDrag(): void {
    this.dragHandle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = this.host.getBoundingClientRect();
      this.drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originLeft: rect.left,
        originTop: rect.top,
      };
      this.dragHandle.setPointerCapture(event.pointerId);
    });

    this.dragHandle.addEventListener("pointermove", (event) => {
      const drag = this.drag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      this.moveTo(
        drag.originLeft + (event.clientX - drag.startX),
        drag.originTop + (event.clientY - drag.startY),
      );
    });

    const release = (event: PointerEvent): void => {
      const drag = this.drag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      this.drag = null;
      this.dragHandle.releasePointerCapture?.(event.pointerId);
    };
    this.dragHandle.addEventListener("pointerup", release);
    this.dragHandle.addEventListener("pointercancel", release);
    this.dragHandle.addEventListener("lostpointercapture", release);
  }

  /** Switch to manual only on user intent, not layout scroll. */
  private switchToManualScroll(): void {
    if (!this.autoScroll) return;
    this.autoScroll = false;
    this.followButton.hidden = false;
  }

  /** Manual scroll (used in tests or when forcing). */
  scrollBy(delta: number): void {
    this.switchToManualScroll();
    this.lineHost.scrollTop += delta;
  }

  /**
   * Scroll only the caption frame; `scrollIntoView()` would drag the whole page
   * and break video position.
   */
  private scrollToCurrent(): void {
    if (this.activeKey === null) return;
    const current = this.renderedByKey.get(this.activeKey);
    if (!current) return;
    const lineTop = current.wrapper.offsetTop;
    const lineBottom = lineTop + current.wrapper.offsetHeight;
    const viewportTop = this.lineHost.scrollTop;
    const viewportBottom = viewportTop + this.lineHost.clientHeight;
    let target = viewportTop;
    if (lineTop < viewportTop) target = lineTop;
    else if (lineBottom > viewportBottom) target = lineBottom - this.lineHost.clientHeight;
    this.setProgrammaticScrollTop(target);
  }

  setColors(next: Partial<CaptionColors>): void {
    this.colors = { ...this.colors, ...next };
    this.host.style.setProperty("--en", this.colors.en);
    this.host.style.setProperty("--vi", this.colors.vi);
    for (const key of Object.keys(this.colors) as CaptionColorKey[]) {
      const input = this.colorInputs.get(key);
      if (input && input.value !== this.colors[key]) {
        input.value = this.colors[key];
      }
    }
  }

  getColors(): CaptionColors {
    return { ...this.colors };
  }

  setWordPickHandler(handler: (pick: WordPick) => void): void {
    this.wordPick = handler;
  }

  /** Mount secondary action in toolbar, next to settings button. */
  mountToolbarButton(button: HTMLButtonElement): void {
    button.classList.add("icon-button");
    this.toolbar.insertBefore(button, this.settingsMenu);
  }

  /** Lookup by stable key, not DOM position that shifts as lines are added. */
  private pickAt(
    key: string,
    index: number,
  ): Omit<WordPick, "anchor"> | null {
    const line = this.renderedByKey.get(key);
    const word = line?.words[index];
    if (!line || !word) return null;
    const context = line.words.map((w) => w.w).join(" ").trim();
    return { word: word.w, context };
  }

  setWords(words: CaptionWord[]): void {
    // Legacy batch compat: replace per-group, don't infer coverage for sparse replay.
    const groups = groupWords(words);
    const incoming = [...groups.values()].flatMap(members => members.map(w => ({ ...w,
      windowedGroupId: w.windowedGroupId ?? `legacy:${w.captionStart}` })));
    this.applyWindowedPatch({ words: incoming, replaceRanges: [], removedWindowedGroupIds: [] });
  }

  applyWindowedPatch(patch: WindowedPatch<CaptionWord>): boolean {
    const validId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 512;
    if (!patch || !Array.isArray(patch.words) || patch.words.length > 10_000 ||
      !Array.isArray(patch.replaceRanges) || patch.replaceRanges.length > 1000 ||
      !Array.isArray(patch.removedWindowedGroupIds) || patch.removedWindowedGroupIds.length > 1000 ||
      patch.words.some(w => !validWord(w) || w.wordId || w.captionId || !validId(w.windowedGroupId)) ||
      patch.removedWindowedGroupIds.some(id => !validId(id)) ||
      patch.replaceRanges.some(range => !range || !Number.isFinite(range.from) || range.from < 0 ||
        !Number.isFinite(range.to) || range.to < range.from)) return false;
    let fragment = 0;
    const fragmentPrefix = `local:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    this.words = applyPatch(this.words.filter(w => !w.wordId), patch, () => `${fragmentPrefix}:${fragment++}`)
      .concat(this.words.filter(w => Boolean(w.wordId))).sort((a, b) => a.videoStart - b.videoStart);
    // Cap by group to avoid persisting one identity with sliced membership.
    while (this.words.length > 10_000) {
      const key = captionKey(this.words[0]);
      this.words = this.words.filter(word => captionKey(word) !== key);
    }
    this.groupsDirty = true;
    for (const [key, item] of this.translationHistory) {
      const members = this.words.filter(word => captionKey(word) === key);
      if (!members.length || item.windowedGroupId && members.map(w => w.w).join(" ") !== item.text) {
        this.translationHistory.delete(key);
        this.translations.delete(key);
      }
    }
    this.reconcileLines();
    return true;
  }

  setScope(scope: CaptureScope): void {
    this.transcript.setScope(scope);
    this.words = this.words.filter(word => !word.wordId).concat(this.transcript.values());
    this.groupsDirty = true;
    this.reconcileLines();
  }

  applyUpdate(update: WordsUpdate): boolean {
    if (!this.transcript.apply(update)) return false;
    this.words = this.transcript.values();
    this.groupsDirty = true;
    this.reconcileLines();
    this.measureFirstRender();
    return true;
  }

  mergeReplay(words: CaptionWord[]): void {
    const streaming = words.filter(word => Boolean(word.wordId));
    this.transcript.mergeFinalized(streaming);
    if (streaming.length) {
      this.words = this.transcript.values();
      this.groupsDirty = true;
      this.reconcileLines();
    }
    const legacy = words.filter(word => !word.wordId);
    if (legacy.length) this.setWords(legacy);
  }

  finalizedHistory(): { words: CaptionWord[]; translations: SentenceTranslation[] } {
    const words = this.words.filter(word => !word.wordId).concat(this.transcript.finalized());
    const retained = new Set(words.map(captionKey));
    return { words, translations: [...this.translationHistory.entries()]
      .filter(([key]) => retained.has(key)).map(([, item]) => item) };
  }

  private measureFirstRender(): void {
    if (this.metricFramePending || this.host.style.display === "none") return;
    this.metricFramePending = true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      this.metricFramePending = false;
      if (!this.host.isConnected || this.host.style.display === "none") return;
      const viewport = this.lineHost.getBoundingClientRect();
      const finalized = new Set(this.transcript.finalized().map(word => word.wordId));
      for (const line of this.renderedLines) {
        for (let index = 0; index < line.words.length; index++) {
          const word = line.words[index];
          if (!word.wordId || !Number.isFinite(word.capturedAtEpochMs)) continue;
          const rect = line.spans[index].getBoundingClientRect();
          if (!rect.width || !rect.height || rect.bottom <= Math.max(0, viewport.top) ||
              rect.top >= Math.min(window.innerHeight, viewport.bottom) ||
              rect.right <= Math.max(0, viewport.left) || rect.left >= Math.min(window.innerWidth, viewport.right)) continue;
          const lagMs = performance.timeOrigin + performance.now() - word.capturedAtEpochMs!;
          if (!Number.isFinite(lagMs) || lagMs < 0) continue;
          if (!this.firstRendered.has(word.wordId)) {
            this.firstRendered.add(word.wordId);
            console.info(`LAG stage=first wordId=${word.wordId} lagMs=${lagMs.toFixed(1)} provisional=${Boolean(word.provisional)}`);
          }
          if (finalized.has(word.wordId) && !this.finalizedRendered.has(word.wordId)) {
            this.finalizedRendered.add(word.wordId);
            console.info(`LAG stage=finalized wordId=${word.wordId} lagMs=${lagMs.toFixed(1)}`);
          }
        }
      }
    }));
  }

  /** All loaded groups for current video, sorted by first word. */
  private getGroups(): CaptionGroup[] {
    if (!this.groupsDirty) return this.groups;
    const byKey = new Map<string, CaptionWord[]>();
    for (const word of this.words) {
      const group = byKey.get(captionKey(word));
      if (group) group.push(word);
      else byKey.set(captionKey(word), [word]);
    }
    this.groups = Array.from(byKey, ([key, groupWords]) => {
      groupWords.sort((a, b) => a.videoStart - b.videoStart);
      return {
        key,
        words: groupWords,
        signature: groupWords
          .map((w) => `${w.wordId ?? ""}:${w.videoStart}:${w.videoEnd}:${w.w}:${w.provisional}:${w.capturedAtEpochMs}`)
          .join("\u0001"),
      };
    }).sort((a, b) => a.words[0].videoStart - b.words[0].videoStart);
    this.groupsDirty = false;
    return this.groups;
  }

  /** Binary search for last word with `videoStart <= videoTime`. */
  private activeWordAt(videoTime: number): CaptionWord | null {
    let low = 0;
    let high = this.words.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.words[mid].videoStart <= videoTime) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (found === -1) return null;
    const word = this.words[found];
    // Batch ASR may arrive after the word finished playing; don't keep the last word lit across a gap.
    return videoTime < word.videoEnd ? word : null;
  }

  update(videoTime: number): void {
    this.lastVideoTime = videoTime;
    if (this.groupsDirty) this.reconcileLines();
    const word = this.activeWordAt(videoTime);
    this.setActiveWord(word);
    if (this.autoScroll) this.scrollToCurrent();
  }

  /**
   * Incremental DOM update. Never clear `lineHost` — that resets scrollTop and
   * kicks the reader off the old sentence whenever new captions/translations arrive.
   */
  private reconcileLines(): void {
    const groups = this.getGroups();
    const oldScrollTop = this.lineHost.scrollTop;
    const anchor = this.autoScroll ? null : this.captureScrollAnchor();
    const wanted = new Set(groups.map((g) => g.key));

    // After seek: remove lines with same key but different content (signature) to avoid overlap.
    for (const [key, line] of this.renderedByKey) {
      const group = groups.find(g => g.key === key);
      if (group && line.signature !== group.signature) {
        line.wrapper.remove();
        this.renderedByKey.delete(key);
      }
    }

    for (const [key, line] of this.renderedByKey) {
      if (wanted.has(key)) continue;
      line.wrapper.remove();
      this.renderedByKey.delete(key);
    }

    for (let index = 0; index < groups.length; index++) {
      const group = groups[index];
      let line = this.renderedByKey.get(group.key);
      if (!line) {
        line = this.createLine(group);
        this.renderedByKey.set(group.key, line);
      } else if (line.signature !== group.signature) {
        this.patchEnglish(line, group);
      }
      this.patchTranslation(line);

      const expectedNode = this.lineHost.children[index] ?? null;
      if (expectedNode !== line.wrapper) {
        this.lineHost.insertBefore(line.wrapper, expectedNode);
      }
    }

    const retainedWords = new Set(this.words.map(word => word.wordId));
    for (const id of this.firstRendered) if (!retainedWords.has(id)) this.firstRendered.delete(id);
    for (const id of this.finalizedRendered) if (!retainedWords.has(id)) this.finalizedRendered.delete(id);
    for (const key of this.translationHistory.keys()) {
      if (!wanted.has(key)) { this.translationHistory.delete(key); this.translations.delete(key); }
    }
    this.renderedLines = groups
      .map((g) => this.renderedByKey.get(g.key))
      .filter((line): line is RenderedLine => line !== undefined);
    if (anchor && this.renderedByKey.has(anchor.key)) {
      this.restoreScrollAnchor(anchor);
    } else if (!this.autoScroll) {
      // Anchor group replaced by new data: no row to restore by key,
      // but keep numeric position instead of jumping to list start.
      this.setProgrammaticScrollTop(oldScrollTop);
    }
  }

  private createLine(group: CaptionGroup): RenderedLine {
    const wrapper = document.createElement("div");
    wrapper.className = "line line-past";
    wrapper.dataset.captionKey = String(group.key);
    const en = document.createElement("div");
    en.className = "line-en";
    const vi = document.createElement("div");
    vi.className = "line-vi";
    wrapper.append(en, vi);
    const line: RenderedLine = {
      key: group.key,
      wrapper,
      en,
      vi,
      spans: [],
      signature: "",
      words: [],
    };
    this.patchEnglish(line, group);
    this.patchTranslation(line);
    return line;
  }

  private patchEnglish(line: RenderedLine, group: CaptionGroup): void {
    line.en.textContent = "";
    line.words = group.words;
    if (line.key === this.activeKey) this.activeWordIndex = -1;
    line.signature = group.signature;
    line.spans = group.words.map((word, index) => {
      const span = document.createElement("span");
      span.textContent = `${word.w} `;
      span.dataset.captionKey = String(group.key);
      span.dataset.index = String(index);
      if (word.wordId) span.dataset.wordId = word.wordId;
      line.en.appendChild(span);
      return span;
    });
  }

  private patchTranslation(line: RenderedLine): void {
    const text = this.translations.get(line.key) ?? "";
    if (line.vi.textContent !== text) line.vi.textContent = text;
    line.vi.hidden = text === "";
  }

  private setActiveWord(word: CaptionWord | null): void {
    const nextKey = word ? captionKey(word) : null;
    const keyChanged = this.activeKey !== nextKey;
    if (keyChanged) {
      const oldLine =
        this.activeKey === null ? null : this.renderedByKey.get(this.activeKey);
      if (oldLine) {
        oldLine.wrapper.className = "line line-past";
        // Old highlight must vanish immediately on sentence change; otherwise
        // the entire history accumulates blue words and the reader can't tell
        // which word is playing.
        oldLine.spans.forEach((span) => {
          span.className = "";
        });
      }
      this.activeKey = nextKey;
      const nextLine =
        nextKey === null ? null : this.renderedByKey.get(nextKey);
      if (nextLine) nextLine.wrapper.className = "line line-active";
    }

    const line = nextKey === null ? null : this.renderedByKey.get(nextKey);
    const nextIndex = line && word ? line.words.indexOf(word) : -1;
    if (!keyChanged && this.activeWordIndex === nextIndex) return;
    if (line) {
      line.spans.forEach((span, index) => {
        span.className = index === nextIndex ? "word-active" : "";
      });
    }
    this.activeWordIndex = nextIndex;
  }

  /** First line being viewed + offset within that line. */
  private captureScrollAnchor(): ScrollAnchor | null {
    const top = this.lineHost.scrollTop;
    for (const line of this.renderedLines) {
      const bottom = line.wrapper.offsetTop + line.wrapper.offsetHeight;
      if (bottom > top) {
        return { key: line.key, offset: top - line.wrapper.offsetTop };
      }
    }
    const last = this.renderedLines[this.renderedLines.length - 1];
    return last ? { key: last.key, offset: top - last.wrapper.offsetTop } : null;
  }

  private restoreScrollAnchor(anchor: ScrollAnchor): void {
    const line = this.renderedByKey.get(anchor.key);
    if (!line) return;
    this.setProgrammaticScrollTop(line.wrapper.offsetTop + anchor.offset);
  }

  private setProgrammaticScrollTop(value: number): void {
    const max = Math.max(0, this.lineHost.scrollHeight - this.lineHost.clientHeight);
    const target = Math.min(max, Math.max(0, value));
    if (Math.abs(this.lineHost.scrollTop - target) < 1) return;
    this.lineHost.scrollTop = target;
  }

  private applyVi(key: string): void {
    const line = this.renderedByKey.get(key);
    if (!line) return;
    const anchor = this.autoScroll ? null : this.captureScrollAnchor();
    this.patchTranslation(line);
    if (anchor) this.restoreScrollAnchor(anchor);
    else this.scrollToCurrent();
  }

  setTranslation(captionStart: number, vi: string, captionId?: string, text = ""): void {
    const key = captionId ?? `windowed:${captionStart}`;
    this.translations.set(key, vi);
    this.translationHistory.set(key, { captionStart, captionId, text, vi });
    this.applyVi(key);
  }

  setTranslations(list: SentenceTranslation[]): void {
    const anchor = this.autoScroll ? null : this.captureScrollAnchor();
    for (const item of list) {
      const key = captionKey(item);
      if (item.windowedGroupId) {
        const members = this.words.filter(word => captionKey(word) === key);
        if (!members.length || members.map(w => w.w).join(" ") !== item.text) continue;
      }
      this.translations.set(key, item.vi);
      this.translationHistory.set(key, item);
      const line = this.renderedByKey.get(key);
      if (line) this.patchTranslation(line);
    }
    if (anchor) this.restoreScrollAnchor(anchor);
    else this.scrollToCurrent();
  }

  /**
   * Prefer right side; if no room, try left; as last resort overlap video right edge.
   * Ignored when user dragged manually, unless `force`.
   */
  position(rect: DOMRect, force = false): void {
    if (this.userPositioned && !force && this.drag === null) {
      return;
    }

    const width = PANEL_WIDTH_PX;
    const gap = PANEL_GAP_PX;
    const viewportWidth = window.innerWidth;

    let left: number;
    if (rect.right + gap + width <= viewportWidth - KEEP_VISIBLE_PX) {
      left = rect.right + gap;
    } else if (rect.left - gap - width >= KEEP_VISIBLE_PX) {
      left = rect.left - gap - width;
    } else {
      // Neither side fits — overlap video right edge, better than overflowing screen.
      left = Math.max(KEEP_VISIBLE_PX, Math.min(rect.right - width, viewportWidth - width - KEEP_VISIBLE_PX));
    }

    const height = Math.min(window.innerHeight - 24, rect.height || window.innerHeight * 0.7);
    this.host.style.left = `${Math.round(left)}px`;
    this.host.style.top = `${Math.round(rect.top)}px`;
    this.host.style.height = `${Math.round(height)}px`;
    this.host.style.maxWidth = `${DRAGGED_MAX_WIDTH_PX}px`;
  }

  resetToVideoAnchor(): void {
    this.userPositioned = false;
  }

  private moveTo(left: number, top: number): void {
    const host = this.host;
    const rect = host.getBoundingClientRect();
    const width = rect.width || KEEP_VISIBLE_PX;
    const height = rect.height || KEEP_VISIBLE_PX;

    const clampedLeft = Math.min(
      Math.max(left, KEEP_VISIBLE_PX - width),
      window.innerWidth - KEEP_VISIBLE_PX,
    );
    const clampedTop = Math.min(
      Math.max(top, 0),
      window.innerHeight - KEEP_VISIBLE_PX,
    );

    host.style.left = `${Math.round(clampedLeft)}px`;
    host.style.top = `${Math.round(clampedTop)}px`;
    this.userPositioned = true;
  }

  show(): void {
    const wasHidden = this.host.style.display === "none";
    this.host.style.display = "flex";
    if (wasHidden) this.measureFirstRender();
  }

  hide(): void {
    this.host.style.display = "none";
  }

  clear(): void {
    this.words = [];
    this.transcript.clear();
    this.firstRendered.clear();
    this.finalizedRendered.clear();
    this.translationHistory.clear();
    this.translations.clear();
    this.groups = [];
    this.groupsDirty = true;
    this.renderedLines = [];
    this.renderedByKey.clear();
    this.activeKey = null;
    this.activeWordIndex = -1;
    this.autoScroll = true;
    this.followButton.hidden = true;
    this.lineHost.textContent = "";
    this.lineHost.scrollTop = 0;
  }

  get element(): HTMLElement {
    return this.host;
  }
}
