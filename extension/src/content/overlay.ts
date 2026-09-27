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
 * Giữ tối thiểu phần này của khung (px) nằm trong viewport khi kéo.
 *
 * ⚠️ Không giới hạn hoàn toàn: overlay là `position: fixed` và extension
 * **không có UI nào khác** để gọi lại nó — kéo tới mất hẳn thì chỉ còn cách
 * F5. Giữ một mảnh nhỏ ở mép là ranh giới giữa "kéo tuỳ ý" và "mất vĩnh viễn".
 */
const KEEP_VISIBLE_PX = 48;

/** Bề rộng tối đa của khung sau khi user tự kéo (px). */
const DRAGGED_MAX_WIDTH_PX = 560;

export class CaptionOverlay {
  private host: HTMLDivElement;
  private shadow: ShadowRoot;
  private enLine: HTMLDivElement;
  private viLine: HTMLDivElement;
  private dragHandle: HTMLDivElement;
  private words: CaptionWord[] = [];
  private lastLineKey: number = -1;
  private lastLineEnd: number = -1;
  private lastViKey: number = -1;
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

  constructor() {
    this.host = document.createElement("div");
    this.shadow = this.host.attachShadow({ mode: "open" });
    this.viLine = document.createElement("div");
    this.enLine = document.createElement("div");
    this.dragHandle = document.createElement("div");
    this.enLine.className = "line-en";
    this.viLine.className = "line-vi";
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
.word-picked {
  color: #ffd84d;
  text-decoration: underline;
}
.line-vi {
  background: rgba(0, 0, 0, 0.6);
  color: #ffd84d;
  font-size: 15px;
  padding: 4px 12px;
  border-radius: 6px;
  text-align: center;
}
.word-active {
  color: #4fc3f7;
}
`;

    this.shadow.appendChild(style);
    this.shadow.appendChild(this.dragHandle);
    this.shadow.appendChild(this.enLine);
    this.shadow.appendChild(this.viLine);

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
    // vòng lặp để TypeScript ép callback về đúng họ event.
    const release = (event: PointerEvent): void => {
      const drag = this.drag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      this.drag = null;
      this.dragHandle.releasePointerCapture?.(event.pointerId);
    };
    this.dragHandle.addEventListener("pointerup", release);
    this.dragHandle.addEventListener("pointercancel", release);
    this.dragHandle.addEventListener("lostpointercapture", release);

    // Dùng event delegation trên dòng EN thay vì gắn listener vào từng span:
    // `update()` dựng lại span mỗi khi nhóm caption đổi, gắn listener từng span
    // nghĩa là phải gắn lại mỗi lần — và span cũ giữ listener thành rò bộ nhớ.
    this.enLine.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const index = Number(target.getAttribute("data-index"));
      if (!Number.isInteger(index)) return;
      const pick = this.pickAt(index);
      if (pick) this.wordPick?.(pick);
    });

    document.body.appendChild(this.host);
    this.hide();
  }

  /**
   * Lấy từ + câu chứa nó từ span thứ `index` của dòng đang hiện.
   *
   * `index` là lệch trong NHÓM đang hiện, nên cần quyết lại `start` y hệt cách
   * `update()` dò — dùng lại logic ở đây thay vì lưu cả nhóm vào span, vì
   * `data-index` phải là số nhỏ để attribute gọn.
   */
  private pickAt(index: number): WordPick | null {
    if (this.lastLineKey === -1) return null;
    const current = this.words.findIndex(
      (w) => w.captionStart === this.lastLineKey,
    );
    if (current === -1) return null;

    let start = current;
    while (start > 0 && this.words[start - 1].captionStart === this.lastLineKey) {
      start--;
    }
    const word = this.words[start + index];
    if (!word) return null;

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

    this.lastLineKey = -1;
    this.lastLineEnd = -1;
  }

  update(videoTime: number): void {
    let currentIndex = -1;
    for (let i = this.words.length - 1; i >= 0; i--) {
      if (this.words[i].videoStart <= videoTime) {
        currentIndex = i;
        break;
      }
    }
    // Không tìm được ⇒ chưa có từ nào, hoặc video ở vùng CHƯA transcribe
    // (trước từ đầu tiên) ⇒ để trống, chờ ASR.
    if (currentIndex === -1) return;

    const captionStart = this.words[currentIndex].captionStart;

    let start = currentIndex;
    while (start > 0 && this.words[start - 1].captionStart === captionStart) {
      start--;
    }

    let end = currentIndex;
    while (
      end < this.words.length - 1 &&
      this.words[end + 1].captionStart === captionStart
    ) {
      end++;
    }

    const lineKey = captionStart;

    if (lineKey !== this.lastLineKey || end !== this.lastLineEnd) {
      this.lastLineKey = lineKey;
      this.lastLineEnd = end;
      this.enLine.textContent = "";
      this.wordSpans = [];
      for (let i = start; i <= end; i++) {
        const span = document.createElement("span");
        span.textContent = this.words[i].w + " ";
        // Lệch trong nhóm — `pickAt` dùng đúng số này để tra từ.
        span.dataset.index = String(i - start);
        this.enLine.appendChild(span);
        this.wordSpans.push(span);
      }
      // Nhóm chưa có bản dịch ⇒ để trống; `setTranslation` sẽ điền khi nó về.
      this.applyVi(lineKey, true);
    } else {
      this.applyVi(lineKey, false);
    }

    const activeOffset = currentIndex - start;
    this.wordSpans.forEach((span, i) => {
      span.className = i === activeOffset ? "word-active" : "";
    });

  }
  /**
   * Ghi dòng VI cho nhóm đang hiện.
   *
   * `update()` chạy mỗi frame rAF nên chỉ được chạm DOM khi giá trị ĐỔI —
   * `lastViKey` làm việc đó, giống `lastLineKey` cho dòng EN.
   */
  private applyVi(lineKey: number, force: boolean): void {
    if (!force && this.lastViKey === lineKey) return;
    this.lastViKey = lineKey;
    this.viLine.textContent = this.translations.get(lineKey) ?? "";
  }

  /** Bản dịch vừa về cho một nhóm. Điền ngay nếu đó là nhóm đang hiện. */
  setTranslation(captionStart: number, vi: string): void {
    this.translations.set(captionStart, vi);
    if (this.lastLineKey === captionStart) {
      this.lastViKey = -1;
      this.applyVi(captionStart, true);
    }
  }

  /** Bản dịch từ cache khi replay — nạp hàng loạt. */
  setTranslations(list: SentenceTranslation[]): void {
    for (const item of list) {
      this.translations.set(item.captionStart, item.vi);
    }
    if (this.lastLineKey !== -1 && this.translations.has(this.lastLineKey)) {
      this.lastViKey = -1;
      this.applyVi(this.lastLineKey, true);
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
    this.lastLineKey = -1;
    this.lastLineEnd = -1;
    this.lastViKey = -1;
    this.wordSpans = [];
    this.enLine.textContent = "";
    this.viLine.textContent = "";
  }

  get element(): HTMLElement {
    return this.host;
  }
}
