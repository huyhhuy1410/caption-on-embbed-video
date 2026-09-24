/**
 * Side panel: hiển thị lời giải nghĩa của từ user bấm trên overlay (FR-6.1).
 *
 * ⚠️ Gọi `POST /explain-word` THẲNG từ đây, không relay qua service worker:
 * side panel là extension page, đã có `host_permissions` tới `127.0.0.1:8000`
 * nên `fetch` chạy được. Thêm một tầng relay chỉ làm thêm điểm hỏng (SW có
 * thể đang ngủ), không thêm quyền nào.
 *
 * ⚠️ 429 ở đây là chuyện THƯỜNG, không phải lỗi bất thường: backend chia
 * chung 15 request/phút với đường caption, nên đầy cửa sổ xảy ra vài lần mỗi
 * phút là bình thường. Vì vậy phải nói rõ "còn bao lâu nữa thử lại" + cho nút
 * thử lại, không được im lặng (xem Issue 5.16).
 */

const BACKEND = "http://127.0.0.1:8000";

type WordPick = { word: string; context: string };

type WordExplanation = {
  word: string;
  meaning: string;
  translation: string;
  example: string;
  pronunciation: string | null;
};

const root = requireElement("content");

/**
 * `document.getElementById` trả `HTMLElement | null`, và TypeScript KHÔNG
 * giữ kiểu đã thu hẹp từ `throw` bên ngoài vào trong thân hàm — nên phải
 * ép kiểu ở đúng một chỗ, thay vì `as` rải khắp nơi.
 */
function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Caption AI: side panel thiếu #${id}`);
  }
  return element;
}

/** Lần chọn từ hiện tại — giữ lại để nút "thử lại" không cần user bấm lại. */
let current: WordPick | null = null;
/** Khoá chống bấm hai lần liên tiếp khi request đang bay. */
let inFlight = false;

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "explain-request" && typeof message.word === "string") {
    current = { word: message.word, context: String(message.context ?? "") };
    void load(current);
  }
});

async function load(pick: WordPick): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  render({ kind: "loading" }, pick);
  try {
    const response = await fetch(`${BACKEND}/explain-word`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        word: pick.word,
        context: pick.context,
        lang: "vi",
      }),
    });

    // 429/503 ở đây là HTTP bình thường (không phải lỗi mạng) nên `fetch`
    // KHÔNG throw — phải rẽ theo `response.status`, không dùng try/catch.
    if (response.status === 429) {
      const body = (await response.json()) as { retryAfterMs?: number };
      const waitMs =
        typeof body.retryAfterMs === "number" ? body.retryAfterMs : 0;
      render({ kind: "throttled", waitMs }, pick);
      return;
    }
    if (response.status === 503) {
      render({ kind: "unavailable" }, pick);
      return;
    }
    if (!response.ok) {
      render({ kind: "error", message: `HTTP ${response.status}` }, pick);
      return;
    }

    const explanation = (await response.json()) as WordExplanation;
    render({ kind: "ok", explanation }, pick);
  } catch (error: unknown) {
    // Backend không chạy, hoặc extension không được phép gọi host đó.
    render(
      {
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      },
      pick,
    );
  } finally {
    inFlight = false;
  }
}

type State =
  | { kind: "loading" }
  | { kind: "ok"; explanation: WordExplanation }
  | { kind: "throttled"; waitMs: number }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

function render(state: State, pick: WordPick): void {
  const parts: HTMLElement[] = [
    node("div", "word", pick.word),
    node("div", "context", pick.context),
  ];

  if (state.kind === "loading") {
    parts.push(node("div", "placeholder", "Đang hỏi AI…"));
  } else if (state.kind === "ok") {
    const e = state.explanation;
    parts.push(field("Nghĩa", e.meaning));
    parts.push(field("Dịch nghĩa", e.translation));
    parts.push(field("Ví dụ", e.example));
    if (e.pronunciation) {
      parts.push(field("Cách đọc", e.pronunciation, "value ipa"));
    }
  } else if (state.kind === "throttled") {
    const seconds = Math.max(1, Math.ceil(state.waitMs / 1000));
    parts.push(
      node(
        "div",
        "note",
        `Đã hết lượt AI cho phút này. Thử lại sau ${seconds}s ` +
          `(lượt dịch phụ đề và lượt giải nghĩa dùng chung một hạn mức).`,
      ),
    );
    parts.push(retryRow());
  } else if (state.kind === "unavailable") {
    // 503 = model quá tải, KHÔNG phải hết quota ⇒ không được nói "hết lượt".
    parts.push(
      node("div", "note", "AI đang quá tải. Bấm thử lại sau ít phút."),
    );
    parts.push(retryRow());
  } else {
    parts.push(
      node("div", "error", `Không gọi được backend: ${state.message}`),
    );
    parts.push(retryRow());
  }

  root.replaceChildren(...parts);
}

function node(
  tag: "div" | "button",
  className: string,
  text: string,
): HTMLElement {
  const element = document.createElement(tag);
  element.className = className;
  // ⚠️ `textContent`, KHÔNG `innerHTML`: `word` đến từ trang web và
  // `meaning`/`example` đến từ Gemini — cả hai đều là văn bản không đáng
  // tin. Dựng DOM bằng API thuần khiến XSS không thể xảy ra, thay vì phải
  // escape thủ công rồi ghép chuỗi (dễ sót một nhánh).
  element.textContent = text;
  return element;
}

function field(label: string, value: string, valueClass = "value"): HTMLElement {
  const row = node("div", "row", "");
  row.appendChild(node("div", "label", label));
  row.appendChild(node("div", valueClass, value));
  return row;
}

/** Nút thử lại dùng lại chính `load` — user không phải bấm lại vào từ. */
function retryRow(): HTMLElement {
  const button = node("button", "", "Thử lại") as HTMLButtonElement;
  button.type = "button";
  button.addEventListener("click", () => {
    if (current) void load(current);
  });
  const row = node("div", "row", "");
  row.appendChild(button);
  return row;
}
