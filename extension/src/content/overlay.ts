export interface CaptionWord {
  w: string;
  videoStart: number;
  videoEnd: number;
  captionStart: number;
}

export class CaptionOverlay {
  private host: HTMLDivElement;
  private shadow: ShadowRoot;
  private enLine: HTMLDivElement;
  private viLine: HTMLDivElement;
  private words: CaptionWord[] = [];
  private lastLineKey: number = -1;
  private lastLineEnd: number = -1;
  private wordSpans: HTMLSpanElement[] = [];

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
    }

    const activeOffset = currentIndex - start;
    this.wordSpans.forEach((span, i) => {
      span.className = i === activeOffset ? "word-active" : "";
    });

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
    this.lastLineKey = -1;
    this.lastLineEnd = -1;
    this.wordSpans = [];
    this.enLine.textContent = "";
    this.viLine.textContent = "";
  }

  get element(): HTMLElement {
    return this.host;
  }
}
