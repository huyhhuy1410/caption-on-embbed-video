import { CaptionOverlay } from "./overlay";
console.info("Caption AI: content script loaded", window.location.href);

let captionEnabled = false;
let activeVideo: HTMLVideoElement | null = null;
const overlay = new CaptionOverlay();

function repositionOverlay() {
  if (!activeVideo) return;
  overlay.position(activeVideo.getBoundingClientRect());
}
// === BƯỚC 1: Lắng nghe tín hiệu kích hoạt caption từ Service Worker ===
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "capturing") {
    captionEnabled = true;
    overlay.show();
    repositionOverlay();
    if (activeVideo) {
      void chrome.runtime
        .sendMessage({
          type: "video-clock",
          videoTime: activeVideo.currentTime,
        })
        .catch((error: unknown) => {
          console.warn("Caption AI: could not send initial video clock", error);
        });
    }
  }
  if (
    (message.type === "words" || message.type === "replay") &&
    Array.isArray(message.words)
  ) {
    overlay.setWords(message.words);
  }
});

// === BƯỚC 2: Bắt sự kiện media qua Event Delegation (Capture phase) ===
// 2.1. Đồng bộ tiến trình video (currentTime) sang Service Worker
document.addEventListener(
  "timeupdate",
  (e) => {
    if (!captionEnabled) return;
    if (!activeVideo || e.target !== activeVideo) return;
    overlay.update(activeVideo.currentTime);
    repositionOverlay();
    void chrome.runtime
      .sendMessage({
        type: "video-clock",
        videoTime: activeVideo.currentTime,
      })
      .catch(() => {
        // Service worker may not be ready yet.
      });
  },
  { capture: true },
);

// 2.2. Gửi tín hiệu tua (seek) để backend reset bộ đệm audio/caption
document.addEventListener(
  "seeked",
  (e) => {
    console.info("Caption AI: seeked fired", {
      enabled: captionEnabled,
      match: e.target === activeVideo,
    });
    if (!captionEnabled) return;
    if (!activeVideo || e.target !== activeVideo) return;

    const message = {
      type: "seek",
      seekTimeAtCapture: activeVideo.currentTime,
    };
    console.info("Caption AI: video seeked", message);
    void chrome.runtime.sendMessage(message).catch((error: unknown) => {
      console.warn("Caption AI: could not send seek", error);
    });
  },
  { capture: true },
);

// === BƯỚC 3: Xác định activeVideo theo thứ tự ưu tiên ===
// Lưu ý: querySelectorAll("video") không tìm được video nằm trong Shadow DOM.
// Tạm chấp nhận cho phạm vi MVP, cần xử lý đệ quy shadowRoot (open) ở phiên bản sau.
function reconcile() {
  const prevVideo = activeVideo;
  const videos = Array.from(document.querySelectorAll("video"));

  if (videos.length === 0) {
    activeVideo = null;
  } else {
    // 1. Ưu tiên video đang phát
    const playingVideo = videos.find((v) => !v.paused && !v.ended);
    if (playingVideo) {
      activeVideo = playingVideo;
    } else if (activeVideo && activeVideo.isConnected) {
      // 2. Giữ nguyên video hiện tại nếu vẫn còn trong DOM
    } else {
      // 3. Fallback sang video hiển thị đầu tiên
      const visibleVideo = videos.find(
        (v) => v.offsetWidth > 0 || v.offsetHeight > 0,
      );
      activeVideo = visibleVideo ?? videos[0];
    }
  }

  if (activeVideo !== prevVideo) {
    console.info("Caption AI: active video reconciled", activeVideo);
  }
}

// === BƯỚC 4: Kích hoạt reconcile theo vòng đời DOM và sự kiện phát ===
// 4.1. Quét video khi khởi động script
reconcile();

// 4.2. Chuyển activeVideo ngay khi có video bắt đầu phát
document.addEventListener(
  "play",
  (e) => {
    if (e.target instanceof HTMLVideoElement) {
      reconcile();
    }
  },
  { capture: true },
);
window.addEventListener("scroll", repositionOverlay, {
  capture: true,
  passive: true,
});
window.addEventListener("resize", repositionOverlay, { passive: true });
// 4.3. Theo dõi DOM để cập nhật khi có video được thêm/xoá
function hasPossibleVideoNode(node: Node): boolean {
  return (
    node.nodeType === Node.ELEMENT_NODE &&
    ((node as Element).matches("video") ||
      (node as Element).querySelector("video") !== null)
  );
}

const observer = new MutationObserver((mutations) => {
  const hasVideoChange = mutations.some(
    (mutation) =>
      Array.from(mutation.addedNodes).some(hasPossibleVideoNode) ||
      Array.from(mutation.removedNodes).some(hasPossibleVideoNode),
  );

  if (hasVideoChange) {
    reconcile();
  }
});

observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
});
