let capturedTabId: number | undefined;

console.info("Caption AI: service worker loaded");

/**
 * MV3 giết service worker sau ~30s idle, nên state phiên phải nằm trong
 * `chrome.storage.session`: giữ trong biến thì `capturedTabId` mất và lần bấm
 * sau BẬT capture thứ hai thay vì tắt.
 */
const SESSION_KEY = "captionSession";
type CaptionSession = { tabId: number };

const BACKEND_URL = "http://127.0.0.1:8000";

type ExplainResult =
  | { ok: true; explanation: unknown }
  | { ok: false; kind: "throttled"; retryAfterMs: number }
  | { ok: false; kind: "unavailable" }
  | { ok: false; kind: "error"; message: string };

/**
 * Content script không fetch được cross-origin, nên nó hỏi qua service worker.
 * Trả `true` để giữ kênh message mở cho tới khi request xong — thiếu nó thì
 * `sendResponse` sau `await` sẽ mất.
 */
async function requestExplanation(
  word: string,
  context: string,
): Promise<ExplainResult> {
  try {
    const response = await fetch(`${BACKEND_URL}/explain-word`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ word, context, lang: "vi" }),
    });
    if (response.status === 429) {
      const body = (await response.json()) as { retryAfterMs?: number };
      return {
        ok: false,
        kind: "throttled",
        retryAfterMs:
          typeof body.retryAfterMs === "number" ? body.retryAfterMs : 0,
      };
    }
    if (response.status === 503) return { ok: false, kind: "unavailable" };
    if (!response.ok) {
      return { ok: false, kind: "error", message: `HTTP ${response.status}` };
    }
    return { ok: true, explanation: await response.json() };
  } catch (error: unknown) {
    return {
      ok: false,
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readSession(): Promise<CaptionSession | undefined> {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  const value: unknown = stored[SESSION_KEY];
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { tabId?: unknown }).tabId === "number"
  ) {
    return value as CaptionSession;
  }
  return undefined;
}

// Chrome chỉ cấp `activeTab` khi user bấm icon, nên đây là gesture surface duy
// nhất để bật; và cũng là chỗ tự nhiên nhất để tắt.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  const tabId = tab.id;

  void (async () => {
    const session = await readSession();
    if (session !== undefined && session.tabId === tabId) {
      await stopCapture(tabId);
      return;
    }
    await startCapture(tabId);
  })().catch((error: unknown) => {
    console.error("Caption AI SW: toggle failed", error);
  });
});


chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "video-clock") {
    void chrome.runtime
      .sendMessage({
        type: "video-clock",
        videoTime: message.videoTime,
      })
      .catch((error: unknown) => {
        console.warn("Caption AI SW: could not relay video clock", error);
      });
  }

  // Đổi video: relay xuống offscreen để ghim nguồn vào chunk audio kế tiếp
  // (Issue 5.20). Không đi qua content script — content đã gửi, SW chỉ nối.
  if (message?.type === "source-switch") {
    void chrome.runtime
      .sendMessage({
        type: "source-switch",
        sourceId: message.sourceId,
      })
      .catch((error: unknown) => {
        console.warn("Caption AI SW: could not relay source switch", error);
      });
  }

  if (message?.type === "seek") {
    console.info("Caption AI SW: seek received", message);
    void chrome.runtime
      .sendMessage({
        type: "seek",
        seekTimeAtCapture: message.seekTimeAtCapture,
      })
      .catch((error: unknown) => {
        console.warn("Caption AI SW: could not relay seek", error);
      });
  }

  if (message?.type === "explain-popup-request") {
    void requestExplanation(String(message.word ?? ""), String(message.context ?? ""))
      .then((result) => sendResponse(result))
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }

  // Chuyển tiếp kết quả từ backend xuống content script của tab đang capture.
  // ⚠️ Phải chuyển NGUYÊN message, không dựng lại object `{type, words}` như
  // trước — cách đó làm rơi mọi field khác mà backend gửi kèm.
  if (
    message?.type === "words" ||
    message?.type === "replay" ||
    message?.type === "translation"
  ) {
    void (async () => {
      // Đọc từ storage chứ không dùng biến in-memory: SW có thể đã ngủ và tỉnh
      // dậy, lúc đó `capturedTabId` là `undefined` dù phiên vẫn đang chạy.
      const session = await readSession();
      const tabId = session?.tabId ?? capturedTabId;
      if (tabId === undefined) return;
      await chrome.tabs.sendMessage(tabId, message).catch((error: unknown) => {
        console.warn("Caption AI SW: could not relay to content", error);
      });
    })();
  }
});

async function startCapture(tabId: number): Promise<void> {
  const streamId = await new Promise<string>((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message ?? "Could not capture tab audio"));
        return;
      }
      resolve(id);
    });
  });

  console.info("Caption AI SW: tab capture stream ID acquired", {
    tabId,
    streamId,
  });

  await ensureOffscreenDocument();
  await new Promise<void>((resolve) => setTimeout(resolve, 100));

  console.info("Caption AI SW: dispatching start-audio-capture to offscreen");
  chrome.runtime.sendMessage({
    type: "start-audio-capture",
    streamId,
    tabId,
  });

  capturedTabId = tabId;
  await chrome.storage.session.set({ [SESSION_KEY]: { tabId } });

  await chrome.tabs.sendMessage(tabId, { type: "capturing" });
}

/**
 * Tắt hẳn phiên: dừng capture ở offscreen, báo content script ẩn overlay.
 *
 * Không gọi `chrome.offscreen.closeDocument()` — giữ document sống để lần bật
 * sau không dính bẫy Issue 2.3 (receiver phải tồn tại trước khi send).
 */
async function stopCapture(tabId: number): Promise<void> {
  console.info("Caption AI SW: stopping capture", { tabId });

  capturedTabId = undefined;
  await chrome.storage.session.remove(SESSION_KEY);

  // Offscreen dọn socket/AudioContext; nó KHÔNG có `chrome.tabs` nên không tự
  // báo được cho content script (Issue 5.1) — SW làm việc đó.
  await chrome.runtime
    .sendMessage({ type: "stop-audio-capture" })
    .catch((error: unknown) => {
      console.warn("Caption AI SW: could not stop audio capture", error);
    });

  await chrome.tabs
    .sendMessage(tabId, { type: "captions-off" })
    .catch((error: unknown) => {
      console.warn("Caption AI SW: could not notify content", error);
    });
}

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({});
  const exists = contexts.some(
    (context) => context.contextType === "OFFSCREEN_DOCUMENT",
  );

  if (!exists) {
    console.info("Caption AI SW: creating offscreen document");
    await chrome.offscreen.createDocument({
      url: "dist/offscreen/offscreen.html",
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: "Capture tab audio for local transcription.",
    });
  }
}
