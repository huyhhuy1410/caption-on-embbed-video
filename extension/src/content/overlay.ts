export interface CaptionWord {
  w: string;
  videoStart: number;
  videoEnd: number;
  captionStart: number;
}

/** Bản dịch một câu. `captionStart` là khoá nhóm, ổn định qua replay. */
export interface SentenceTranslation {
  captionStart: number;
  text: string;
  vi: string;
}

export class CaptionOverlay {
  private host: HTMLDivElement;
  private shadow: ShadowRoot;
  private enLine: HTMLDivElement;
  private viLine: HTMLDivElement;
  private words: CaptionWord[] = [];
  private lastLineKey: number = -1;
  private lastLineEnd: number = -1;
  private lastViKey: number = -1;
  private wordSpans: HTMLSpanElement[] = [];

  /** Bản dịch theo `captionStart`. Bản dịch về muộn hơn words nên giữ riêng. */
  private translations = new Map<number, string>();

  constructor() {
    this.host = document.createElement("div");
    this.shadow = this.host.attachShadow({ mode: "open" });
    this.viLine = document.createElement("div");
    this.enLine = document.createElement("div");
    this.enLine.className = "line-en";
    this.viLine.className = "line-vi";
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
  padding-bottom: 12px;
  box-sizing: border-box;
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
    this.shadow.appendChild(this.enLine);
    this.shadow.appendChild(this.viLine);
    document.body.appendChild(this.host);
    this.hide();
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

  position(rect: DOMRect): void {
    this.host.style.left = `${rect.left}px`;
    this.host.style.width = `${rect.width}px`;
    this.host.style.bottom = `${window.innerHeight - rect.bottom + 12}px`;
    this.host.style.top = "auto";
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
