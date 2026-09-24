import { CaptionFullscreen } from "./fullscreen";
import { CaptionOverlay } from "./overlay";
console.info("Caption AI: content script loaded", window.location.href);

let captionEnabled = false;
let activeVideo: HTMLVideoElement | null = null;
let overlayFrameId: number | null = null;
const overlay = new CaptionOverlay();
const fullscreen = new CaptionFullscreen();

// Click vào một từ trên overlay → SW relay → side panel gọi /explain-word.
// Không gọi thẳng từ content script: content script không được fetch tới
// host ngoài (CORS), và side panel là nơi có chỗ hiển thị lời giải nghĩa.
overlay.setWordPickHandler((pick) => {
  void chrome.runtime
    .sendMessage({
      type: "explain-request",
      word: pick.word,
      context: pick.context,
    })
    .catch((error: unknown) => {
      // Side panel chưa mở là chuyện thường, không phải lỗi cần báo user.
      console.info("Caption AI: explain request chưa tới side panel", error);
    });
});

function repositionOverlay() {
  if (!activeVideo) return;
  // Trong CC fullscreen, getBoundingClientRect là element box phủ kín màn hình
  // chứ không phải vùng ảnh — uỷ quyền cho fullscreen tính cho đúng.
  if (fullscreen.isActive()) {
    fullscreen.repositionOverlay();
    return;
  }
  overlay.position(activeVideo.getBoundingClientRect());
}
function updateOverlayFromVideo(): void {
  if (!captionEnabled || !activeVideo || activeVideo.paused) {
    overlayFrameId = null;
    return;
  }
  overlay.update(activeVideo.currentTime);
  overlayFrameId = window.requestAnimationFrame(updateOverlayFromVideo);
}
function startOverlayLoop(): void {
  if (
    !captionEnabled ||
    !activeVideo ||
    activeVideo.paused ||
    overlayFrameId !== null
  ) {
    return;
  }
  overlayFrameId = window.requestAnimationFrame(updateOverlayFromVideo);
}
function stopOverlayLoop(): void {
  if (overlayFrameId !== null) {
    window.cancelAnimationFrame(overlayFrameId);
    overlayFrameId = null;
  }
}

function updateOverlayNow(): void {
  if (!activeVideo) return;
  overlay.update(activeVideo.currentTime);
}

/**
 * Visibility suy ra từ state. Nếu để show()/hide() bật tắt ở hai nơi khác nhau
 * thì sau khi SPA gỡ video làm overlay ẩn, không còn gì bật lại — show() chỉ
 * chạy lúc nhận `capturing`.
 */
function syncOverlayVisibility(): void {
  if (captionEnabled && activeVideo) {
    overlay.show();
  } else {
    overlay.hide();
  }
}

// === BƯỚC 1: Lắng nghe tín hiệu kích hoạt caption từ Service Worker ===
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "capturing") {
    captionEnabled = true;
    syncOverlayVisibility();
    repositionOverlay();
    if (activeVideo) {
      // `dispose()` lúc tắt đã gỡ nút và xoá target, nên phải gắn lại ở đây —
      // không thì nút CC fullscreen chỉ mọc lại khi tình cờ có mutation DOM.
      fullscreen.setTarget(activeVideo, overlay);
      updateOverlayNow();
      startOverlayLoop();

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
    // Replay mang kèm bản dịch đã cache ⇒ VI hiện ngay, không đợi AI (FR-7.5).
    if (Array.isArray(message.translations)) {
      overlay.setTranslations(message.translations);
    }
    updateOverlayNow();
  }
  if (
    message.type === "translation" &&
    typeof message.captionStart === "number"
  ) {
    overlay.setTranslation(message.captionStart, String(message.vi ?? ""));
  }
  if (message.type === "captions-off") {
    captionEnabled = false;
    stopOverlayLoop();
    overlay.clear();
    fullscreen.dispose();
    // Visibility suy ra từ state nên set cờ là đủ để overlay tự ẩn.
    syncOverlayVisibility();
  }
});

// === BƯỚC 2: Bắt sự kiện media qua Event Delegation (Capture phase) ===
// 2.1. Đồng bộ tiến trình video (currentTime) sang Service Worker
document.addEventListener(
  "timeupdate",
  (e) => {
    if (!captionEnabled) return;
    if (!activeVideo || e.target !== activeVideo) return;

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

    updateOverlayNow();
    repositionOverlay();
    startOverlayLoop();
  },
  { capture: true },
);
document.addEventListener(
  "pause",
  (e) => {
    if (e.target === activeVideo) {
      updateOverlayNow();
      stopOverlayLoop();
    }
  },
  { capture: true },
);
document.addEventListener(
  "ended",
  (e) => {
    if (e.target === activeVideo) {
      stopOverlayLoop();
    }
  },
  { capture: true },
);

// === BƯỚC 3: Xác định activeVideo theo thứ tự ưu tiên ===
// Lưu ý: querySelectorAll("video") không tìm được video nằm trong Shadow DOM.
// Tạm chấp nhận cho phạm vi MVP, cần xử lý đệ quy shadowRoot (open) ở phiên bản sau.
function reconcile() {
  // Phiên CC fullscreen có thể đã hỏng mà không sinh fullscreenchange nào.
  fullscreen.recoverIfBroken();

  const videos = Array.from(document.querySelectorAll("video"));
  let nextVideo: HTMLVideoElement | null = null;

  if (videos.length === 0) {
    nextVideo = null;
  } else {
    // 1. Ưu tiên video đang phát
    const playingVideo = videos.find((v) => !v.paused && !v.ended);
    if (playingVideo) {
      nextVideo = playingVideo;
    } else if (activeVideo && activeVideo.isConnected) {
      // 2. Giữ nguyên video hiện tại nếu vẫn còn trong DOM
      nextVideo = activeVideo;
    } else {
      // 3. Fallback sang video hiển thị đầu tiên
      const visibleVideo = videos.find(
        (v) => v.offsetWidth > 0 || v.offsetHeight > 0,
      );
      nextVideo = visibleVideo ?? videos[0];
    }
  }

  if (nextVideo !== activeVideo) {
    stopOverlayLoop();
    activeVideo = nextVideo;
    console.info("Caption AI: active video reconciled", activeVideo);

    // videoStart là mốc thời gian riêng của từng video, nên từ vựng giữ lại sẽ
    // khớp nhầm với video mới và hiện phụ đề của bài trước.
    overlay.clear();
  }

  // Không đổi target khi đang ở CC fullscreen: wrapper và nút đang gắn với
  // video cũ, đổi giữa chừng sẽ bỏ rơi nó trong wrapper.
  if (activeVideo && !fullscreen.isActive()) {
    fullscreen.setTarget(activeVideo, overlay);
  }

  syncOverlayVisibility();

  // Vẽ ngay: vòng rAF chỉ chạy khi video đang phát, nên video mới lúc pause sẽ
  // không được vẽ lần nào cho tới khi user bấm play.
  if (captionEnabled && activeVideo) {
    updateOverlayNow();
    repositionOverlay();
  }

  if (activeVideo && !activeVideo.paused) {
    startOverlayLoop();
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
      startOverlayLoop();
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
