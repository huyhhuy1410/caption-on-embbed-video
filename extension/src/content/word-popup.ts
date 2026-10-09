import type { WordPick } from "./overlay";

type Explanation = {
  word: string;
  meaning: string;
  translation: string;
  example: string;
  pronunciation: string | null;
};

type Response =
  | { ok: true; explanation: Explanation }
  | { ok: false; kind: "throttled"; retryAfterMs: number }
  | { ok: false; kind: "unavailable" }
  | { ok: false; kind: "error"; message: string };

/** Popup giải nghĩa gắn cạnh từ vừa bấm; click ngoài hoặc × để đóng. */
export class WordPopup {
  private host: HTMLDivElement;
  private shadow: ShadowRoot;
  private card: HTMLDivElement;
  /** Thanh kéo. Giữ tham chiếu vì `renderBase()` xoá lại con của card. */
  private grab: HTMLDivElement;
  private current: WordPick | null = null;
  private requestId = 0;

  /** Popup đã bị user kéo ⇒ `position()` không neo lại cạnh từ nữa. */
  private dragged = false;

  private readonly onOutside = (event: Event): void => {
    if (!this.host.isConnected || this.host.hidden) return;
    if (event.composedPath().includes(this.host)) return;
    this.hide();
  };

  private readonly onDragStart = (event: PointerEvent): void => {
    // Kéo chỉ bằng thanh trên cùng: phần còn lại của card là nội dung và nút,
    // bấm chúng phải là bấm chứ không phải bắt đầu kéo — cùng lý do tách
    // `.drag-handle` riêng ở overlay (gotcha #45).
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startY = event.clientY;
    const originLeft = parseFloat(this.host.style.left) || 0;
    const originTop = parseFloat(this.host.style.top) || 0;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);

    const onMove = (move: PointerEvent): void => {
      this.host.style.left = `${originLeft + (move.clientX - startX)}px`;
      this.host.style.top = `${originTop + (move.clientY - startY)}px`;
    };
    const onUp = (up: PointerEvent): void => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      // Chỉ đánh dấu "đã kéo" khi thật sự dịch — bấm nhầm vào thanh không được
      // làm popup rời khỏi từ, nếu không thì chỉ cần bấm là mất neo.
      if (
        Math.abs(up.clientX - startX) > 3 ||
        Math.abs(up.clientY - startY) > 3
      ) {
        this.dragged = true;
      }
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  constructor() {
    this.host = document.createElement("div");
    this.host.dataset.captionAiOwned = "";
    this.shadow = this.host.attachShadow({ mode: "open" });
    this.card = document.createElement("div");
    this.card.className = "card";
    this.grab = document.createElement("div");
    this.grab.className = "grab";
    this.grab.title = "Drag to move";
    this.grab.addEventListener("pointerdown", this.onDragStart);

    const style = document.createElement("style");
    style.textContent = `
:host {
  position: fixed;
  z-index: 100000000;
  pointer-events: none;
  font-family: system-ui, sans-serif;
}
.card {
  pointer-events: auto;
  position: relative;
  width: min(300px, calc(100vw - 24px));
  max-height: min(380px, calc(100vh - 24px));
  overflow-y: auto;
  box-sizing: border-box;
  padding: 13px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 9px;
  color: #eee;
  background: rgba(18, 18, 20, 0.97);
  box-shadow: 0 12px 35px rgba(0, 0, 0, 0.48);
}
.close {
  position: absolute;
  top: 6px;
  right: 7px;
  width: 24px;
  height: 24px;
  padding: 0;
  color: #ccc;
  background: transparent;
  border: 0;
  font: 17px/1 system-ui, sans-serif;
  cursor: pointer;
}
.word {
  padding-right: 25px;
  color: #fff;
  font-size: 17px;
  font-weight: 700;
}
.context {
  margin-top: 3px;
  color: #999;
  font-size: 11px;
  line-height: 1.35;
}
.field {
  margin-top: 10px;
}
.label {
  color: #888;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .04em;
  text-transform: uppercase;
}
.value {
  margin-top: 2px;
  color: #e7e7e7;
  font-size: 13px;
  line-height: 1.4;
}
.note, .error, .loading {
  margin-top: 12px;
  color: #bbb;
  font-size: 12px;
  line-height: 1.4;
}
.error { color: #ff9b9b; }
.retry {
  margin-top: 9px;
  padding: 5px 9px;
  color: #fff;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 5px;
  cursor: pointer;
}
/* Popup neo sát từ vừa bấm nên hay đè lên dòng caption. Thanh này là đường
   thoát: kéo ra chỗ trống, hoặc chấp nhận che. */
.grab {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 11px;
  cursor: grab;
  touch-action: none;
}
.grab:active { cursor: grabbing; }
`;
    this.shadow.append(style, this.card);
    this.card.appendChild(this.grab);
    this.host.hidden = true;
    document.body.appendChild(this.host);
    document.addEventListener("pointerdown", this.onOutside, true);
  }

  async show(pick: WordPick): Promise<void> {
    const sameWord = this.current?.word === pick.word;
    this.current = pick;
    const id = ++this.requestId;
    // Popup mới luôn neo lại cạnh từ vừa bấm. Giữ vị trí đã kéo chỉ khi bấm LẠI
    // đúng từ đó — bấm từ khác thì kéo xong không còn ý nghĩa gì.
    if (!sameWord) this.dragged = false;
    this.renderBase(pick);
    this.card.appendChild(node("div", "loading", "Loading explanation…"));
    this.host.hidden = false;
    this.position(pick);

    try {
      const response = (await chrome.runtime.sendMessage({
        type: "explain-popup-request",
        word: pick.word,
        context: pick.context,
      })) as Response | undefined;
      if (id !== this.requestId || this.host.hidden) return;
      this.renderResponse(response ?? {
        ok: false,
        kind: "error",
        message: "No response from extension service worker",
      });
      this.position(pick);
    } catch (error: unknown) {
      if (id !== this.requestId || this.host.hidden) return;
      this.renderResponse({
        ok: false,
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      this.position(pick);
    }
  }

  hide(): void {
    this.requestId += 1;
    this.current = null;
    this.host.hidden = true;
  }

  private renderBase(pick: WordPick): void {
    // `renderBase` chạy lại mỗi lần vẽ (loading → xong → retry) nên nó dựng
    // lại toàn bộ con. Giữ `grab` sống sót qua `textContent = ""`, hoặc popup
    // sẽ mất đường kéo ngay sau lần vẽ đầu tiên.
    const grab = this.grab;
    this.card.textContent = "";
    this.card.appendChild(grab);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "close";
    close.textContent = "×";
    close.title = "Close";
    close.setAttribute("aria-label", "Close explanation");
    close.addEventListener("click", () => this.hide());
    this.card.append(
      close,
      node("div", "word", pick.word),
      node("div", "context", pick.context),
    );
  }

  private renderResponse(response: Response): void {
    const pick = this.current;
    if (!pick) return;
    this.renderBase(pick);
    if (response.ok) {
      this.card.append(
        field("Meaning", response.explanation.meaning),
        field("Translation", response.explanation.translation),
        field("Example", response.explanation.example),
      );
      if (response.explanation.pronunciation) {
        this.card.append(field("Pronunciation", response.explanation.pronunciation));
      }
      return;
    }
    if (response.kind === "throttled") {
      const seconds = Math.max(1, Math.ceil(response.retryAfterMs / 1000));
      this.card.append(
        node("div", "note", `AI quota reached. Try again in ${seconds}s.`),
        this.retryButton(),
      );
    } else if (response.kind === "unavailable") {
      this.card.append(
        node("div", "note", "AI is temporarily unavailable."),
        this.retryButton(),
      );
    } else {
      this.card.append(
        node("div", "error", `Could not load explanation: ${response.message}`),
        this.retryButton(),
      );
    }
  }

  private retryButton(): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "retry";
    button.textContent = "Try again";
    button.addEventListener("click", () => {
      if (this.current) void this.show(this.current);
    });
    return button;
  }

  private position(pick: WordPick): void {
    // Đã kéo thì giữ chỗ user đặt. `position()` còn được gọi lại sau khi lời
    // giải nghĩa về (chiều cao card đổi), nếu không chặn ở đây thì popup bị
    // nhảy về cạnh từ đúng lúc user đang đọc.
    if (this.dragged) return;

    const width = this.card.offsetWidth || 300;
    const height = this.card.offsetHeight || 180;
    const gap = 8;
    let left = pick.anchor.left;
    let top = pick.anchor.bottom + gap;
    if (left + width > window.innerWidth - gap) {
      left = window.innerWidth - width - gap;
    }
    if (top + height > window.innerHeight - gap) {
      top = pick.anchor.top - height - gap;
    }
    this.host.style.left = `${Math.max(gap, Math.round(left))}px`;
    this.host.style.top = `${Math.max(gap, Math.round(top))}px`;
  }
}

function node(tag: "div", className: string, text: string): HTMLDivElement {
  const element = document.createElement(tag);
  element.className = className;
  // Nội dung đến từ trang và model; `textContent` giữ nó là text, không phải HTML.
  element.textContent = text;
  return element;
}

function field(label: string, value: string): HTMLDivElement {
  const row = node("div", "field", "");
  row.append(node("div", "label", label), node("div", "value", value));
  return row;
}
