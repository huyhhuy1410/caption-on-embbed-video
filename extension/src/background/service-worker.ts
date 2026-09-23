let capturedTabId: number | undefined;

console.info("Caption AI: service worker loaded");

/**
 * Trạng thái phiên phải nằm trong `chrome.storage.session`, không phải biến
 * in-memory: MV3 giết service worker sau ~30s idle, biến mất theo. Khi đó
 * `capturedTabId` về `undefined` và lần bấm sau sẽ BẬT capture thứ hai thay vì
 * tắt — đúng cái bug mà storage tránh được.
 */
const SESSION_KEY = "captionSession";
type CaptionSession = { tabId: number };

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

// === BƯỚC 1: Icon toolbar là công tắc — bật nếu chưa chạy, tắt nếu đang chạy ===
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

// === BƯỚC 2: Lắng nghe tin nhắn từ Content Script hoặc các trang nội bộ ===
chrome.runtime.onMessage.addListener((message) => {
  // 2.1. Nhận mốc video.currentTime và chuyển tiếp (relay) sang cho Offscreen Document
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

  // 2.2. Chuyển tiếp kết quả từ backend xuống content script của tab đang capture.
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

// === BƯỚC 3: Hàm thực hiện lấy Stream ID của Tab và kích hoạt Offscreen ===
async function startCapture(tabId: number): Promise<void> {
  // 3.1. Bọc API Callback chrome.tabCapture thành Promise để await lấy streamId
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

  // 3.2. Đảm bảo Offscreen Document đã được khởi tạo
  await ensureOffscreenDocument();
  await new Promise<void>((resolve) => setTimeout(resolve, 100));

  // 3.3. Gửi tin nhắn chứa streamId cho Offscreen Document bắt đầu ghi âm
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

// === BƯỚC 4: Khởi tạo Offscreen Document (tài liệu chạy ẩn) ===
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
