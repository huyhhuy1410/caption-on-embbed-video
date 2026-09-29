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

/**
 * Số câu đã hiện được giữ lại phía trên câu hiện tại (FR-4.8).
 *
 * ⚠️ Vì sao cần: Style A thay câu trước NGAY lúc câu sau bắt đầu (FR-4.1).
 * Với độ trễ đo được ~4.07s, một câu ngắn 2 giây đã nói xong và biến mất
 * trước khi chữ tới ⇒ người đọc mất dòng. Giữ lại vài câu đã hiện là cách
 * chữa *mất dòng* mà không cần chạm vào pipeline.
 *
 * ⚠️ Đánh đổi: mỗi câu thêm chiều cao, che nhiều video hơn. Khi M7.5 hạ độ trễ
 * xuống <2s thì con số này nên giảm dần về 0.
 */
const DEFAULT_PAST_LINES = 3;

/**
 * Giữ tối thiểu phần này của khung (px) nằm trong viewport khi kéo.
 *
 * ⚠️ Không giới hạn hoàn toàn: overlay là `position: fixed` và extension
 * **không có UI nào khác** để gọi lại nó — kéo tới mất hẳn thì chỉ còn cách
 * F5. Giữ một mảnh nhỏ ở mép là ranh giới giữa "kéo tuỳ ý" và "mất vĩnh viễn".
 */
const KEEP_VISIBLE_PX = 48;

/** Bề rộng tối đa của khung sau khi user tự kéo (px). */
const DRAGGED_MAX_WIDTH_PX = 560;

/** Một dòng caption đã dựng trong DOM. */
interface RenderedLine {
  /** `captionStart` của nhóm — khoá bản dịch và khoá tra từ khi bấm. */
  key: number;
  en: HTMLDivElement;
  vi: HTMLDivElement;
  spans: HTMLSpanElement[];
  /** Lệch trong `words` của từ đầu nhóm — dùng cho `pickAt` khi bấm từ. */
  start: number;
  /** Lệch trong `words` của từ cuối nhóm. */
  end: number;
}

export class CaptionOverlay {
  private host: HTMLDivElement;
  private shadow: ShadowRoot;
  /** Chứa các dòng caption; tách riêng để dựng lại mà không đụng drag handle. */
  private lineHost: HTMLDivElement;
  private dragHandle: HTMLDivElement;
  private words: CaptionWord[] = [];
  private wordSpans: HTMLSpanElement[] = [];

  /** Bản dịch theo `captionStart`. Bản dịch về muộn hơn words nên giữ riêng. */
  private translations = new Map<number, string>();

  /** Gửi từ user bấm ra ngoài. Xem `onWordPick`. */
  private wordPick: ((pick: WordPick) => void) | null = null;

  /**
   * User đã tự kéo overlay chưa — quyết định `position()` còn neo theo
   * video hay giữ nguyên chỗ user đặt (FR-4.4 "user-movable").
   *
   * ⚠️ Trước khi có cờ này, `position()` ghi đè vị trí mỗi lần scroll/resize
   * nên kéo xong là bị kéo về neo video. Giữ cờ thành sticky: đổi video vẫn
   * neo lại (đúng ý user — vị trí là lựa chọn, nội dung mới là dữ liệu).
   */
  private userPositioned = false;

  /** Kéo đang diễn ra: mốc bắt đầu. `null` khi không kéo. */
  private drag: {
    pointerId: number;
    startX: number;
    startY: number;
    originLeft: number;
    originTop: number;
  } | null = null;

  /** Số câu giữ lại phía trên câu hiện tại (FR-4.8). `0` = Style A thuần. */
  private pastLineCount = DEFAULT_PAST_LINES;

  /** Các dòng đang có trong DOM, cũ → mới. */
  private renderedLines: RenderedLine[] = [];

  /**
   * Khoá của bộ dòng đang hiển thị — chuỗi `captionStart` nối bằng dấu phẩy.
   *
   * ⚠️ Chỉ dựng lại DOM khi khoá này ĐỔI. `update()` chạy 60 lần/giây, dựng
   * lại mỗi lần thì rẻ tiền rất nhanh.
   */
  private linesKey = "";

  /** `videoTime` của lần `update()` gần nhất — dùng để dựng lại khi đổi cấu
   * hình khi video đang pause (không có vòng rAF để gọi lại). */
  private lastVideoTime = 0;

  constructor() {
    this.host = document.createElement("div");
    this.shadow = this.host.attachShadow({ mode: "open" });
    this.lineHost = document.createElement("div");
    this.dragHandle = document.createElement("div");
    this.dragHandle.className = "drag-handle";
    const style = document.createElement("style");
    style.textContent = `
:host {
  position: fixed;
  z-index: 99999999;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  font-family: system-ui, sans-serif;
  box-sizing: border-box;
  max-width: ${DRAGGED_MAX_WIDTH_PX}px;
}
/* Vùng kéo: thanh riêng ở mép trên, KHÔNG nằm trên dòng caption.
   Nếu kéo bằng dòng caption thì đụng bề mặt click-từ (FR-6.1) — click và
   bấm-giữ không tách được. Ở đây mới bật pointer-events vì :host tắt. */
.drag-handle {
  pointer-events: auto;
  cursor: move;
  width: 100%;
  min-width: 120px;
  height: 14px;
  border-radius: 6px 6px 0 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  touch-action: none;
}
.drag-handle::after {
  content: "";
  width: 40px;
  height: 3px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.5);
}
.drag-handle:hover {
  background: rgba(0, 0, 0, 0.65);
}
.drag-handle:hover::after {
  background: rgba(255, 255, 255, 0.8);
}
/* Khối chứa các dòng caption. Tách riêng khỏi drag handle để dựng lại danh
   sách dòng không xoá nhầm vùng kéo. */
.lines {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 100%;
}
.line {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  max-width: 100%;
}
.line-en {
  background: rgba(0, 0, 0, 0.75);
  color: #fff;
  font-size: 20px;
  font-weight: 600;
  padding: 6px 14px;
  border-radius: 6px;
  text-align: center;
  line-height: 1.35;
  /* Chỉ dòng EN nhận chuột — nó là bề mặt click-any-word (FR-6.1). Giữ
     :host ở pointer-events:none để phần còn lại của overlay vẫn không chắn
     thao tác lên video (controls, tua, chuột phải). */
  pointer-events: auto;
  cursor: pointer;
  /* Cao hơn :host để mọi phần tử con (span) cũng nhận chuột, không chỉ nền
     của div — pointer-events không tự kế thừa xuống. */
  z-index: 1;
}
.line-vi {
  background: rgba(0, 0, 0, 0.6);
  color: #ffd84d;
  font-size: 15px;
  padding: 4px 12px;
  border-radius: 6px;
  text-align: center;
}
/* Câu đã hiện (FR-4.8): mờ đi và nhỏ lại để dòng hiện tại nổi hẳn, nhưng vẫn
   bấm được — đây chính là bề mặt đọc lại. */
.line-past {
  opacity: 0.6;
}
.line-past .line-en {
  font-size: 16px;
  font-weight: 500;
  padding: 3px 10px;
  background: rgba(0, 0, 0, 0.6);
}
.line-past .line-vi {
  font-size: 13px;
  padding: 2px 8px;
}
.word-picked {
  color: #ffd84d;
  text-decoration: underline;
}
.word-active {
  color: #4fc3f7;
}
`;

    this.shadow.appendChild(style);
    this.shadow.appendChild(this.dragHandle);
    this.shadow.appendChild(this.lineHost);

    // Drag dùng pointer events (một listener cho cả chuột/touch/cả ngón vừa
    // chạm vừa kéo) + `setPointerCapture` để chuột chạy ra ngoài khung vẫn
    // kéo được — không cần listener trên `window`.
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

    // `lostpointercapture` là đường duy nhất bắt được việc chuột bị thả
    // ngoài cửa sổ trình duyệt — `pointerup` không nổ trong trường hợp đó.
    //
    // ⚠️ Vì `addEventListener` trên HTMLElement nhận `EventListener`, TS suy
    // kiểu tham số là `Event` ⇒ không có `pointerId`. Khai báo rõ kiểu trong
    // vòng lặp để TypeScript ép callback về đúng kiểu ho event.
    const release = (event: PointerEvent): void => {
      const drag = this.drag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      this.drag = null;
      this.dragHandle.releasePointerCapture?.(event.pointerId);
    };
    this.dragHandle.addEventListener("pointerup", release);
    this.dragHandle.addEventListener("pointercancel", release);
    this.dragHandle.addEventListener("lostpointercapture", release);

    // Dùng event delegation trên khối dòng thay vì gắn listener vào từng span:
    // `buildLines()` dựng lại span mỗi khi bộ dòng đổi, gắn listener từng span
    // nghĩa là phải gắn lại mỗi lần — và span cũ giữ listener thành rò bộ nhớ.
    //
    // ⚠️ Bắt trên `lineHost` chứ không trên một dòng: Style B có N+1 dòng, và
    // `data-line` cho biết span thuộc dòng nào. Bắt trên từng dòng sẽ phải gắn
    // lại listener mỗi lần dựng dòng.
    this.lineHost.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const line = Number(target.getAttribute("data-line"));
      const index = Number(target.getAttribute("data-index"));
      if (!Number.isInteger(line) || !Number.isInteger(index)) return;
      const pick = this.pickAt(line, index);
      if (pick) this.wordPick?.(pick);
    });

    document.body.appendChild(this.host);
    this.hide();
  }

  /**
   * Lấy từ + câu chứa nó từ span `index` của dòng `lineIndex`.
   *
   * ⚠️ Bắt buộc phải truyền `lineIndex` (FR-4.8). Trước Style B, dòng hiện tại
   * là `lastLineKey` — duy nhất — nên tra bằng `findIndex` trên `lastLineKey` là
   * đủ. Giữ nhiều dòng thì con số đó **không còn định danh được dòng nào**;
   * tra nhầm thì click-từ giải thích sai câu (FR-6.3 cần ngữ cảnh đúng).
   */
  private pickAt(lineIndex: number, index: number): WordPick | null {
    const line = this.renderedLines[lineIndex];
    if (!line) return null;
    const word = this.words[line.start + index];
    if (!word || line.start + index > line.end) return null;

    // Câu = mọi từ cùng `captionStart`. Rút gọn khoảng trắng vì `join(" ")`.
    const context = this.words
      .filter((w) => w.captionStart === word.captionStart)
      .map((w) => w.w)
      .join(" ")
      .trim();
    return { word: word.w, context };
  }

  /** Đăng ký callback khi user bấm một từ. Xem `WordPick`. */
  setWordPickHandler(handler: (pick: WordPick) => void): void {
    this.wordPick = handler;
  }

  /**
   * Số câu giữ lại phía trên câu hiện tại (FR-4.8). `0` = Style A thuần.
   *
   * Dựng lại ngay vì video có thể đang pause — không có vòng rAF để gọi lại
   * `update()`.
   */
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

  setWords(words: CaptionWord[]): void {
    this.words = this.words.concat(words);
    this.words.sort((a, b) => a.videoStart - b.videoStart);

    // Sidecar dùng sliding window overlap 1.5s ⇒ vùng chồng bị transcribe
    // 2 lần và gửi 2 lần. Sau khi sort, các bản trùng nằm LIỀN KỀ nhau,
    // nên chỉ cần so với từ vừa được giữ lại.
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

    // `words` vừa bị dựng lại nên mọi lệch trong `renderedLines` đã hỏng.
    // Xoá khoá để `update()` dựng DOM lại ở frame kế.
    this.linesKey = "";
  }

  /** Lệch đầu / cuối của nhóm `captionStart` chứa `index`. */
  private groupBounds(index: number): { start: number; end: number } {
    const key = this.words[index].captionStart;
    let start = index;
    while (start > 0 && this.words[start - 1].captionStart === key) start--;
    let end = index;
    while (end < this.words.length - 1 && this.words[end + 1].captionStart === key) {
      end++;
    }
    return { start, end };
  }

  /**
   * Bộ dòng cần hiển thị: N câu đã hiện + câu hiện tại, cũ → mới (FR-4.8).
   *
   * Đi ngược từ nhóm hiện tại, mỗi lần lấy nguyên một nhóm rồi lùi tiếp. Dừng
   * khi đã đủ N câu trước.
   */
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

    // Chưa có từ nào, hoặc video ở vùng CHƯA transcribe (trước từ đầu tiên)
    // ⇒ không dòng nào để hiện, chờ ASR.
    if (currentIndex === -1) {
      this.renderLines([], currentIndex);
      return;
    }

    this.renderLines(this.visibleBounds(currentIndex), currentIndex);
  }

  /**
   * Dựng bộ dòng hiển thị, hoặc chỉ cập nhật từ đang sáng nếu bộ dòng không đổi.
   *
   * `update()` chạy mỗi frame rAF, nên phần đắt (dựng span) chỉ chạy khi
   * `linesKey` đổi; phần nhẹ (đổi class của từ đang sáng) chạy mỗi frame.
   */
  private renderLines(
    bounds: { start: number; end: number }[],
    activeIndex: number,
  ): void {
    const key = bounds.map((b) => this.words[b.start].captionStart).join(",");
    if (key !== this.linesKey) {
      this.linesKey = key;
      this.buildLines(bounds);
    }

    // Từ đang sáng chỉ nằm ở dòng CUỐI. Câu đã hiện không có từ "đang nói".
    const current = this.renderedLines[this.renderedLines.length - 1];
    if (!current) return;
    const activeOffset = activeIndex - current.start;
    for (const span of current.spans) {
      const index = Number(span.dataset.index);
      span.className = index === activeOffset ? "word-active" : "";
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
      wrapper.className = isCurrent ? "line" : "line line-past";

      const en = document.createElement("div");
      en.className = "line-en";
      const spans: HTMLSpanElement[] = [];
      for (let i = group.start; i <= group.end; i++) {
        const span = document.createElement("span");
        span.textContent = this.words[i].w + " ";
        // Hai khoá: dòng nào, và lệch trong nhóm — `pickAt` cần cả hai.
        span.dataset.line = String(lineIndex);
        span.dataset.index = String(i - group.start);
        en.appendChild(span);
        spans.push(span);
      }
      wrapper.appendChild(en);

      const vi = document.createElement("div");
      vi.className = "line-vi";
      // Chưa có bản dịch thì để trống — `applyVi` điền khi nó về. `hidden` để
      // không chừa một ô nền đen rỗng dưới câu chưa được dịch.
      vi.hidden = !this.translations.has(key);
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

      const viText = this.translations.get(key) ?? "";
      vi.textContent = viText;
      vi.hidden = viText === "";
    });
  }

  /**
   * Ghi dòng VI cho một dòng đã dựng.
   *
   * `update()` chạy mỗi frame rAF nên chỉ được chạm DOM khi giá trị ĐỔI.
   * So sánh trực tiếp với `textContent` thay vì giữ một `lastViKey` như trước:
   * giờ có N+1 dòng, một mốc đơn không đủ để biết dòng nào đã cập nhật.
   */
  private applyVi(key: number, force: boolean): void {
    const text = this.translations.get(key) ?? "";
    for (const line of this.renderedLines) {
      if (line.key !== key) continue;
      if (!force && line.vi.textContent === text) continue;
      line.vi.textContent = text;
      line.vi.hidden = text === "";
    }
  }

  /** Bản dịch vừa về cho một nhóm. Điền ngay nếu dòng đó đang hiện. */
  setTranslation(captionStart: number, vi: string): void {
    this.translations.set(captionStart, vi);
    this.applyVi(captionStart, true);
  }

  /** Bản dịch từ cache khi replay — nạp hàng loạt. */
  setTranslations(list: SentenceTranslation[]): void {
    for (const item of list) {
      this.translations.set(item.captionStart, item.vi);
    }
    for (const line of this.renderedLines) {
      this.applyVi(line.key, false);
    }
  }

  /**
   * Neo overlay theo vị trí video (FR-4.4).
   *
   * ⚠️ Sau khi user kéo, KHÔNG neo nữa — nếu neo thì mỗi lần scroll/resize
   * sẽ kéo overlay về chỗ cũ, tức là tính năng kéo trở về vô dụng sau vài
   * giây. Giữ `width` theo video nhưng để `left/top` user đặt.
   */
  position(rect: DOMRect, force = false): void {
    if (this.userPositioned && !force && this.drag === null) {
      this.host.style.width = `${rect.width}px`;
      this.host.style.maxWidth = `${DRAGGED_MAX_WIDTH_PX}px`;
      return;
    }
    this.host.style.left = `${rect.left}px`;
    this.host.style.width = `${rect.width}px`;
    this.host.style.maxWidth = `${DRAGGED_MAX_WIDTH_PX}px`;
    this.host.style.bottom = `${window.innerHeight - rect.bottom + 12}px`;
    this.host.style.top = "auto";
  }

  /**
   * Bỏ vị trí user đã kéo, quay về neo theo video.
   *
   * ⚠️ Bắt buộc khi vào/ra CC fullscreen: overlay được dời vào wrapper 100%×100%,
   * còn `left`/`top` đang lưu theo **viewport của trang**. Giữ nguyên thì
   * overlay nằm ở toạ độ cũ trong hệ toạ độ mới ⇒ lệch chỗ. Gọi `position()`
   * với `force` để ghi đè, đồng thời xoá cờ cho các lần `position()` sau.
   */
  resetToVideoAnchor(): void {
    this.userPositioned = false;
  }

  /**
   * Đặt overlay theo toạ độ viewport, giữ tối thiểu một mảnh trong màn hình.
   *
   * Dùng `left`+`top` chứ không phải `bottom`: `bottom` đang được neo theo
   * video, và màn hình co lại (F11, xoay tablet) sẽ làm `bottom` cũ giữ
   * overlay ở mép dưới mà ta không kiểm soát được.
   */
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

    // `bottom` phải bỏ trước, không thì `top` + `bottom` cùng lúc thì
    // trình duyệt coi `top` là `auto` và overlay nhảy theo chiều cao window.
    host.style.bottom = "auto";
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

  /**
   * `words` là mảng tích luỹ và videoStart là mốc thời gian riêng của từng
   * video — đổi video mà không xoá thì phụ đề bài cũ sẽ hiện lên bài mới.
   */
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
