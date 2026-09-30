export interface CaptionWord {
  w: string;
  videoStart: number;
  videoEnd: number;
  captionStart: number;
}

/** Từ user vừa bấm, kèm câu chứa nó — `/explain-word` cần ngữ cảnh để giải
 * nghĩa đúng nghĩa trong video, không phải nghĩa từ điển. */
export interface WordPick {
  word: string;
  context: string;
}

/** Bản dịch một câu. `captionStart` là khoá nhóm, ổn định qua replay. */
export interface SentenceTranslation {
  captionStart: number;
  text: string;
  vi: string;
}

/** Màu của hai dòng chữ. Bạn chọn trong bảng màu (FR-4.9). */
export interface CaptionColors {
  en: string;
  vi: string;
}

/**
 * Mặc định: EN trắng, VI xám.
 *
 * ⚠️ VI xám chìm hơn trắng một cách có chủ đích: dòng EN là thứ người đọc
 * theo dõi, dòng VI là phụ trợ. Trước đây VI dùng `#ffd84d` (vàng) — đậm hơn
 * EN, kéo mắt người xem sang phần không phải phần cần theo.
 */
const DEFAULT_COLORS: CaptionColors = { en: "#ffffff", vi: "#9e9e9e" };

/** Bảng màu cho `input[type=color]`. */
const PRESET_COLORS: Record<string, CaptionColors> = {
  mặc_định: { en: "#ffffff", vi: "#9e9e9e" },
  cao_độ_tương_phản: { en: "#ffffff", vi: "#e0e0e0" },
  dịu: { en: "#f5f5f5", vi: "#757575" },
  ấm: { en: "#fff8e1", vi: "#bcaaa4" },
  mát: { en: "#e3f2fd", vi: "#90a4ae" },
};

/**
 * Khoảng cách giữa panel và mép video (px), và bề rộng panel.
 *
 * ⚠️ Panel đặt BÊN CẠNH video chứ không nằm trên video: 3 câu + bản dịch
 * chiếm gần hết màn hình khi nằm trong (Parker, 2026-09-29). Bên cạnh thì
 * video không bị che, và bản dịch vẫn đọc được.
 */
const PANEL_GAP_PX = 12;
const PANEL_WIDTH_PX = 320;

/** Bề rộng tối đa khung sau khi user tự kéo (px). */
const DRAGGED_MAX_WIDTH_PX = 560;

/**
 * Giữ tối thiểu phần này của khung (px) nằm trong viewport khi kéo.
 *
 * ⚠️ Không giới hạn hoàn toàn: overlay là `position: fixed` và extension
 * **không có UI nào khác** để gọi lại nó — kéo tới mất hẳn thì chỉ còn cách
 * F5. Giữ một mảnh nhỏ ở mép là ranh giới giữa "kéo tuỳ ý" và "mất vĩnh viễn".
 */
const KEEP_VISIBLE_PX = 48;

/**
 * Câu đã hiện được giữ lại bao nhiêu (FR-4.8).
 *
 * ⚠️ Style A thay câu trước NGAY lúc câu sau bắt đầu. Với độ trễ đo được
 * ~4.07s, câu ngắn 2s đã nói xong trước khi chữ tới ⇒ mất dòng. Giữ vài câu
 * là cách chữa mất dòng mà không cần đụng pipeline.
 */
const DEFAULT_PAST_LINES = 8;

/** Một dòng caption đã dựng trong DOM. */
interface RenderedLine {
  key: number;
  en: HTMLDivElement;
  vi: HTMLDivElement;
  spans: HTMLSpanElement[];
  start: number;
  end: number;
}

export class CaptionOverlay {
  private host: HTMLDivElement;
  private shadow: ShadowRoot;
  private lineHost: HTMLDivElement;
  private dragHandle: HTMLDivElement;
  private colorBar: HTMLDivElement;
  private followButton: HTMLButtonElement;
  private words: CaptionWord[] = [];
  private wordSpans: HTMLSpanElement[] = [];
  private translations = new Map<number, string>();
  private wordPick: ((pick: WordPick) => void) | null = null;
  private userPositioned = false;
  private drag: {
    pointerId: number;
    startX: number;
    startY: number;
    originLeft: number;
    originTop: number;
  } | null = null;
  private pastLineCount = DEFAULT_PAST_LINES;
  private colors: CaptionColors = { ...DEFAULT_COLORS };
  private renderedLines: RenderedLine[] = [];
  private linesKey = "";
  private lastVideoTime = 0;

  /**
   * Đang cuộn tay hay tự cuộn theo câu đang phát.
   *
   * ⚠️ `update()` chạy 60 lần/giây. Mặc định cuộn theo câu đang phát; khi người
   * cuộn tay thì dừng lại và hiện nút "theo lại" để quay về auto.
   */
  private autoScroll = true;

  /**
   * Sự kiện `scroll` tiếp theo là do CHÍNH overlay đặt, không phải người.
   *
   * ⚠️ Cờ này chỉ đúng cho MỘT sự kiện. Gán `scrollTop` khi giá trị đã bằng
   * nhau thì trình duyệt **không** phát sự kiện, còn cờ thì vẫn còn ⇒ lần cuộn
   * tay kế tiếp sẽ bị nuốt mất. Vì vậy `scrollToCurrent` chỉ đặt cờ khi giá
   * trị thực sự đổi.
   */
  private selfScroll = false;

  constructor() {
    this.host = document.createElement("div");
    this.shadow = this.host.attachShadow({ mode: "open" });
    this.lineHost = document.createElement("div");
    this.dragHandle = document.createElement("div");
    this.colorBar = document.createElement("div");
    this.followButton = document.createElement("button");
    this.dragHandle.className = "drag-handle";

    const style = document.createElement("style");
    style.textContent = `
:host {
  position: fixed;
  z-index: 99999999;
  /* Không bắt chuột: phần còn lại của trang (kể cả controls/tua của video)
     phải bấm được. Chỉ các vùng con tự bật pointer-events. */
  pointer-events: none;
  display: flex;
  flex-direction: column;
  font-family: system-ui, sans-serif;
  box-sizing: border-box;
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
/* Vùng cuộn. overflow-y bật thanh cuộn khi nội dung dài hơn khung —
   đó là "đọc lại" (Parker yêu cầu 2026-09-29). */
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
.word-active {
  color: #4fc3f7;
}
.bar {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  border-top: 1px solid rgba(255, 255, 255, 0.12);
  padding-top: 5px;
}
.bar > * {
  pointer-events: auto;
}
button {
  font: inherit;
  font-size: 11px;
  color: #ddd;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 4px;
  padding: 2px 6px;
  cursor: pointer;
}
button:hover {
  background: rgba(255, 255, 255, 0.2);
}
/* Nút "theo lại" chỉ hiện khi đang cuộn tay — mặc định auto-scroll thì vô
   nghĩa, và một nút thừa chỉ gây rối. */
button.follow {
  margin-left: auto;
  background: rgba(79, 195, 247, 0.22);
  border-color: #4fc3f7;
  color: #fff;
}
/* input[type=color] mặc định có viền dày của UA — bỏ đi cho gọn. */
input[type="color"] {
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 3px;
  background: none;
  cursor: pointer;
}
`;

    this.host.style.setProperty("--en", this.colors.en);
    this.host.style.setProperty("--vi", this.colors.vi);

    const panel = document.createElement("div");
    panel.className = "panel";

    const bar = document.createElement("div");
    bar.className = "bar";
    const enColor = this.makeColorInput("EN", this.colors.en, (v) =>
      this.setColors({ en: v }),
    );
    const viColor = this.makeColorInput("VI", this.colors.vi, (v) =>
      this.setColors({ vi: v }),
    );
    this.followButton.className = "follow";
    this.followButton.textContent = "theo lại";
    this.followButton.hidden = true;
    this.followButton.addEventListener("click", () => {
      this.autoScroll = true;
      this.followButton.hidden = true;
      this.scrollToCurrent();
    });
    bar.append(enColor, viColor, this.followButton);

    panel.appendChild(this.lineHost);
    panel.appendChild(bar);
    this.lineHost.className = "lines";

    this.shadow.appendChild(style);
    this.shadow.appendChild(this.dragHandle);
    this.shadow.appendChild(panel);

    this.lineHost.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const line = Number(target.getAttribute("data-line"));
      const index = Number(target.getAttribute("data-index"));
      if (!Number.isInteger(line) || !Number.isInteger(index)) return;
      const pick = this.pickAt(line, index);
      if (pick) this.wordPick?.(pick);
    });

    this.lineHost.addEventListener("scroll", () => this.onScroll());

    this.installDrag();

    document.body.appendChild(this.host);
    this.hide();
  }

  private makeColorInput(
    label: string,
    value: string,
    onChange: (hex: string) => void,
  ): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "color";
    input.value = value;
    input.title = `Màu ${label}`;
    input.setAttribute("aria-label", `Màu chữ ${label}`);
    input.addEventListener("input", () => onChange(input.value));
    return input;
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

  /**
   * Cuộn tay ⇒ tắt auto-scroll và hiện nút "theo lại".
   *
   * ⚠️ PHẢI phân biệt "cuộn do tôi đặt" với "cuộn của người". Bản thân việc
   * gán `scrollTop` cũng phát ra sự kiện `scroll`, nên bắt thẳng sẽ khiến
   * auto-scroll tự tắt ngay sau câu đầu tiên — tức tính năng chết ngay lúc bật.
   *
   * ⚠️ Vì sao KHÔNG so `scrollTop` với một "mốc" đã lưu: tôi đã thử, và nó
   * sai. Mốc cũ không khớp vị trí mới sau khi câu kế tiếp cuộn panel đi, nên
   * phép so trả về "lệch" và tắt chính nó. Cờ `selfScroll` đánh dấu đúng thời
   * điểm, không suy đoán.
   */
  private onScroll(): void {
    if (this.selfScroll) {
      // Sự kiện do chính `scrollToCurrent` gây ra — bỏ qua.
      this.selfScroll = false;
      return;
    }
    if (!this.autoScroll) return;
    this.autoScroll = false;
    this.followButton.hidden = false;
  }

  /** Cuộn tay chủ động (dùng khi gọi từ test hoặc khi cần ép). */
  scrollBy(delta: number): void {
    this.lineHost.scrollTop += delta;
    this.onScroll();
  }

  private scrollToCurrent(): void {
    const current = this.renderedLines[this.renderedLines.length - 1];
    if (!current) return;
    const target = current.en.offsetTop;
    // Chỉ đặt cờ khi vị trí thực sự đổi — xem giải thích ở `selfScroll`.
    if (Math.abs(this.lineHost.scrollTop - target) < 1) return;
    this.selfScroll = true;
    this.lineHost.scrollTop = target;
  }

  setColors(next: Partial<CaptionColors>): void {
    this.colors = { ...this.colors, ...next };
    this.host.style.setProperty("--en", this.colors.en);
    this.host.style.setProperty("--vi", this.colors.vi);
    const inputs = this.shadow.querySelectorAll<HTMLInputElement>('input[type="color"]');
    if (inputs[0]) inputs[0].value = this.colors.en;
    if (inputs[1]) inputs[1].value = this.colors.vi;
  }

  getColors(): CaptionColors {
    return { ...this.colors };
  }

  setPastLineCount(count: number): void {
    const next = Math.max(0, Math.floor(count));
    if (next === this.pastLineCount) return;
    this.pastLineCount = next;
    this.linesKey = "";
    this.update(this.lastVideoTime);
  }

  getPastLineCount(): number {
    return this.pastLineCount;
  }

  setWordPickHandler(handler: (pick: WordPick) => void): void {
    this.wordPick = handler;
  }

  private pickAt(lineIndex: number, index: number): WordPick | null {
    const line = this.renderedLines[lineIndex];
    if (!line) return null;
    const word = this.words[line.start + index];
    if (!word || line.start + index > line.end) return null;
    const context = this.words
      .filter((w) => w.captionStart === word.captionStart)
      .map((w) => w.w)
      .join(" ")
      .trim();
    return { word: word.w, context };
  }

  setWords(words: CaptionWord[]): void {
    this.words = this.words.concat(words);
    this.words.sort((a, b) => a.videoStart - b.videoStart);

    const deduped: CaptionWord[] = [];
    for (const word of this.words) {
      const last = deduped[deduped.length - 1];
      if (
        last &&
        last.w.toLowerCase() === word.w.toLowerCase() &&
        Math.abs(last.videoStart - word.videoStart) < 0.5
      ) {
        continue;
      }
      deduped.push(word);
    }
    this.words = deduped;
    this.linesKey = "";
  }

  private groupBounds(index: number): { start: number; end: number } {
    const key = this.words[index].captionStart;
    let start = index;
    while (start > 0 && this.words[start - 1].captionStart === key) start--;
    let end = index;
    while (
      end < this.words.length - 1 &&
      this.words[end + 1].captionStart === key
    ) {
      end++;
    }
    return { start, end };
  }

  private visibleBounds(currentIndex: number): { start: number; end: number }[] {
    const current = this.groupBounds(currentIndex);
    const bounds = [current];
    let cursor = current.start - 1;
    while (cursor >= 0 && bounds.length <= this.pastLineCount) {
      const previous = this.groupBounds(cursor);
      bounds.unshift(previous);
      cursor = previous.start - 1;
    }
    return bounds;
  }

  update(videoTime: number): void {
    this.lastVideoTime = videoTime;

    let currentIndex = -1;
    for (let i = this.words.length - 1; i >= 0; i--) {
      if (this.words[i].videoStart <= videoTime) {
        currentIndex = i;
        break;
      }
    }

    if (currentIndex === -1) {
      this.renderLines([], currentIndex);
      return;
    }

    this.renderLines(this.visibleBounds(currentIndex), currentIndex);
  }

  private renderLines(
    bounds: { start: number; end: number }[],
    activeIndex: number,
  ): void {
    const key = bounds.map((b) => this.words[b.start].captionStart).join(",");
    const changed = key !== this.linesKey;
    if (changed) {
      this.linesKey = key;
      this.buildLines(bounds);
    }

    const current = this.renderedLines[this.renderedLines.length - 1];
    if (!current) return;
    const activeOffset = activeIndex - current.start;
    for (const span of current.spans) {
      const index = Number(span.dataset.index);
      span.className = index === activeOffset ? "word-active" : "";
    }

    if (changed && this.autoScroll) {
      this.scrollToCurrent();
    }
  }

  private buildLines(bounds: { start: number; end: number }[]): void {
    this.lineHost.textContent = "";
    this.renderedLines = [];
    this.wordSpans = [];

    bounds.forEach((group, lineIndex) => {
      const isCurrent = lineIndex === bounds.length - 1;
      const key = this.words[group.start].captionStart;

      const wrapper = document.createElement("div");
      wrapper.className = isCurrent ? "line line-active" : "line line-past";

      const en = document.createElement("div");
      en.className = "line-en";
      const spans: HTMLSpanElement[] = [];
      for (let i = group.start; i <= group.end; i++) {
        const span = document.createElement("span");
        span.textContent = this.words[i].w + " ";
        span.dataset.line = String(lineIndex);
        span.dataset.index = String(i - group.start);
        en.appendChild(span);
        spans.push(span);
      }
      wrapper.appendChild(en);

      const vi = document.createElement("div");
      vi.className = "line-vi";
      const viText = this.translations.get(key) ?? "";
      vi.textContent = viText;
      vi.hidden = viText === "";
      wrapper.appendChild(vi);

      this.lineHost.appendChild(wrapper);
      const rendered: RenderedLine = {
        key,
        en,
        vi,
        spans,
        start: group.start,
        end: group.end,
      };
      this.renderedLines.push(rendered);
      if (isCurrent) this.wordSpans = spans;
    });
  }

  private applyVi(key: number, force: boolean): void {
    const text = this.translations.get(key) ?? "";
    for (const line of this.renderedLines) {
      if (line.key !== key) continue;
      if (!force && line.vi.textContent === text) continue;
      line.vi.textContent = text;
      line.vi.hidden = text === "";
    }
  }

  setTranslation(captionStart: number, vi: string): void {
    this.translations.set(captionStart, vi);
    this.applyVi(captionStart, true);
  }

  setTranslations(list: SentenceTranslation[]): void {
    for (const item of list) {
      this.translations.set(item.captionStart, item.vi);
    }
    for (const line of this.renderedLines) {
      this.applyVi(line.key, false);
    }
  }

  /**
   * Neo panel BÊN CẠNH video, không nằm trong video (Parker, 2026-09-29).
   *
   * ⚠️ Chọn bên phải, và nếu không đủ chỗ thì bên trái — panel rộng 320px
   * trong viewport hẹp sẽ tràn ra ngoài màn hình nếu cứ neo bên phải.
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
      // Không bên nào đủ chỗ ⇒ đè lên mép phải video, vẫn hơn là tràn màn hình.
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
    this.host.style.display = "flex";
  }

  hide(): void {
    this.host.style.display = "none";
  }

  clear(): void {
    this.words = [];
    this.translations.clear();
    this.renderedLines = [];
    this.wordSpans = [];
    this.linesKey = "";
    this.lineHost.textContent = "";
  }

  get element(): HTMLElement {
    return this.host;
  }
}
