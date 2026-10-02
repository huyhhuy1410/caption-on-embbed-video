import { CaptionFullscreen } from "./fullscreen";
import { CaptionOverlay } from "./overlay";
import { isVisible, VideoPicker } from "./video-picker";
import { WordPopup } from "./word-popup";
console.info("Caption AI: content script loaded", window.location.href);

let captionEnabled = false;
let activeVideo: HTMLVideoElement | null = null;
let overlayFrameId: number | null = null;
const overlay = new CaptionOverlay();
const fullscreen = new CaptionFullscreen();
const wordPopup = new WordPopup();

/** Video user CHỈ ĐỊNH qua picker — thắng heuristic của `reconcile()`. */
let userPickedVideo: HTMLVideoElement | null = null;

const picker = new VideoPicker(overlay.element, (video) => {
  // Cố ý không toggle: `reconcile()` ưu tiên "video đang phát" nên bỏ ghim xong
  // nó chọn lại đúng video vừa bỏ, khiến thao tác không đổi được gì. Đổi sang
  // video khác vẫn bấm bình thường nên đường thoát vẫn còn.
  userPickedVideo = video;
  reconcile();
});

// Popup nằm trong content script, nhưng request đi qua service worker vì content
// script không có quyền fetch cross-origin như extension page.
overlay.setWordPickHandler((pick) => {
  void wordPopup.show(pick);
});

function repositionOverlay() {
  if (!activeVideo) return;
  // Không neo vào hộp 0×0 (Issue 5.23) — vị trí tính ra cũng vô nghĩa, và để
  // nguyên `left/top` cũ thì overlay nhảy về chỗ của video TRƯỚC lúc user đổi.
  if (!fullscreen.isActive() && !isVisible(activeVideo)) {
    overlay.hide();
    return;
  }
  // Trong CC fullscreen, getBoundingClientRect là element box phủ kín màn hình
  // chứ không phải vùng ảnh — uỷ quyền cho fullscreen tính cho đúng.
  if (fullscreen.isActive()) {
    fullscreen.repositionOverlay();
    return;
  }
  overlay.position(activeVideo.getBoundingClientRect());
}
/** Giữ chip picker bám mép video đang chọn khi cuộn/zoom layout. */
function repositionPicker(): void {
  if (!activeVideo) return;
  picker.position(activeVideo.getBoundingClientRect());
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

/**
 * Ẩn overlay khi video được chọn không có chỗ để hiện (Issue 5.23).
 *
 * ⚠️ Cố ý KHÔNG đổi sang video nhìn thấy: nhiều trang dùng video 0×0 làm nguồn
 * audio, mà nó VẪN phát ra tiếng và `tabCapture` vẫn bắt. Ưu tiên "video nhìn
 * thấy" sẽ neo nhầm sang video khác trong cùng trang — tệ hơn hẳn việc không
 * hiện gì. Người dùng tự chọn video qua picker nếu muốn xem phụ đề.
 *
 * Vẫn GIỮ overlay trong trường hợp này về mặt dữ liệu: audio vẫn được
 * transcribe, chỉ là không có chỗ để vẽ — nên khi user đổi sang video có hình thì
 * phụ đề của đoạn đang phát hiện ngay, không phải chờ ASR chạy lại từ đầu.
 */
function hideOverlayIfNowhereToShow(): void {
  if (!activeVideo || !isVisible(activeVideo)) {
    overlay.hide();
  } else {
    syncOverlayVisibility();
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "capturing") {
    captionEnabled = true;
    // `syncOverlayVisibility` thôi ở đây: bật caption trên video audio-only sẽ
    // bật overlay lên hộp rộng 0 — đúng lỗi Issue 5.23.
    hideOverlayIfNowhereToShow();
    repositionOverlay();
    if (activeVideo) {
      // `dispose()` lúc tắt đã gỡ nút và xoá target, nên phải gắn lại ở đây —
      // không thì nút CC fullscreen chỉ mọc lại khi tình cờ có mutation DOM.
      fullscreen.setTarget(activeVideo, overlay);
      // ⚠️ Bắt nguồn ngay lúc BẬT, không đợi `reconcile()` đổi video: offscreen
      // mới khởi tạo nên `activeSourceId` của nó đang null, và các chunk đầu
      // sẽ rơi vào namespace chung. `reconcile()` chỉ gọi khi video ĐỔI, mà
      // lúc vừa bật thì `activeVideo` thường đã đúng sẵn (Issue 5.20).
      notifySourceSwitch(activeVideo);
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
    wordPopup.hide();
    fullscreen.dispose();
    // Tắt caption ⇒ ẩn overlay là đúng dù video có hình hay không.
    syncOverlayVisibility();
    picker.clear();
  }
});

// Media event qua event delegation (capture phase).
// Đồng bộ tiến trình video sang Service Worker.
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

// Báo backend tua để nó reset bộ đệm audio/caption.
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

    // Hỏi lại cache của backend cho vùng vừa tua tới (FR-7.2, FR-7.5).
    //
    // Lời gọi này là thứ duy nhất kích hoạt replay từ cache backend. Sau
    // `overlay.clear()` (đổi video, SPA đổi route) thì cache backend là nguồn
    // duy nhất còn dữ liệu, nên đừng "dọn" nó đi khi refactor.
    const message = {
      type: "seek",
      seekTimeAtCapture: activeVideo.currentTime,
    };
    void chrome.runtime.sendMessage(message).catch((error: unknown) => {
      console.warn("Caption AI: could not send seek", error);
    });
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

// 2.3. Buffering: `paused` vẫn `false` nên handler `"pause"` ở trên không bắt
// được (FR-2.4). `waiting` = hết dữ liệu, `stalled` = mạng chậm.
//
// ⚠️ DỪNG OVERLAY, KHÔNG CẮT CAPTURE: `tabCapture` bắt audio CẢ TAB, nên lúc
// video này buffer thì tab vẫn có thể phát tiếng từ video khác. Cắt audio ở
// đây sẽ giết phụ đề của các video sau — đó là quyết định kiến trúc (EC-5),
// không phải sót sót.
//
// ⚠️ KHÔNG dùng `currentTime` để đo "đứng yên": đó là so sánh với chính mốc
// vừa cập nhật ở frame trước, nên vòng rAF tự tắt ngay frame đầu (Issue 5.28).
// `readyState` là trạng thái thật của media pipeline, không suy ra gì cả.
for (const eventName of ["waiting", "stalled"] as const) {
  document.addEventListener(
    eventName,
    (e) => {
      if (e.target !== activeVideo) return;
      console.info(`Caption AI: ${eventName} — freeze overlay loop`);
      stopOverlayLoop();
      updateOverlayNow();
    },
    { capture: true },
  );
}
document.addEventListener(
  "playing",
  (e) => {
    if (e.target !== activeVideo) return;
    updateOverlayNow();
    startOverlayLoop();
  },
  { capture: true },
);

// Lưu ý: querySelectorAll("video") không tìm được video nằm trong Shadow DOM.
// Tạm chấp nhận cho phạm vi MVP, cần xử lý đệ quy shadowRoot (open) ở phiên bản sau.

/**
 * Mã định danh video, ổn định suốt phiên — dùng làm khoá cache (Issue 5.20).
 *
 * ⚠️ Phải là chuỗi, không phải tham chiếu element: `reconcile()` chạy lại rất
 * nhiều (mutation DOM) và tạo element mới thì tham chiếu đổi mọi lần, còn
 * danh tính thì không. Mỗi video một `WeakMap` riêng ⇒ đổi `src` hoặc SPA thay
 * element vẫn ra CÙNG mã, nên cache của video đó còn dùng được.
 */
const sourceIds = new WeakMap<HTMLVideoElement, string>();
let sourceIdCounter = 0;
function sourceIdFor(video: HTMLVideoElement): string {
  let id = sourceIds.get(video);
  if (id === undefined) {
    sourceIdCounter += 1;
    id = `v${sourceIdCounter}`;
    sourceIds.set(video, id);
  }
  return id;
}

/**
 * Báo cho backend biết nguồn âm thanh vừa đổi.
 *
 * ⚠️ Bắn cho MỌI lần đổi, kể cả lúc caption đang TẮT: backend còn giữ cache
 * của video trước, và nếu không báo thì lúc user bật lại caption trên video mới,
 * seek vẫn nhận lời của video cũ.
 */
function notifySourceSwitch(video: HTMLVideoElement): void {
  void chrome.runtime
    .sendMessage({ type: "source-switch", sourceId: sourceIdFor(video) })
    .catch((error: unknown) => {
      // Service worker chưa sẵn sàng thì bỏ qua: chunk audio kế tiếp vẫn mang
      // sourceId nên cache vẫn tách được, chỉ mất độ trễ của lần reset đệm.
      console.warn("Caption AI: could not announce source switch", error);
    });
}

function reconcile() {
  // Phiên CC fullscreen có thể đã hỏng mà không sinh fullscreenchange nào.
  fullscreen.recoverIfBroken();

  const videos = Array.from(document.querySelectorAll("video"));
  let nextVideo: HTMLVideoElement | null = null;

  // User chỉ định qua picker thì thắng heuristic.
  // ("the user can pick which one"). Chỉ dùng khi video đó vẫn còn trong DOM;
  // SPA gỡ đi thì rơi về heuristic bên dưới thay vì treo picker ở video ma.
  const picked =
    userPickedVideo && userPickedVideo.isConnected
      ? userPickedVideo
      : null;
  if (userPickedVideo && !picked) {
    userPickedVideo = null;
  }

  if (videos.length === 0) {
    nextVideo = null;
  } else if (picked) {
    nextVideo = picked;
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
      const visibleVideo = videos.find((v) => isVisible(v));
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
    wordPopup.hide();

    // Bộ đệm audio bên sidecar còn chứa tiếng của video TRƯỚC; backend phải
    // xoá nó, nếu không window đầu của video mới là tiếng cũ gắn mốc thời gian
    // mới (Issue 5.20).
    if (activeVideo) notifySourceSwitch(activeVideo);
  }

  // Không đổi target khi đang ở CC fullscreen: wrapper và nút đang gắn với
  // video cũ, đổi giữa chừng sẽ bỏ rơi nó trong wrapper.
  if (activeVideo && !fullscreen.isActive()) {
    fullscreen.setTarget(activeVideo, overlay);
  }

  hideOverlayIfNowhereToShow();

  // Picker đứng ngoài overlay (xem `video-picker.ts`) nên vẫn hiện được khi
  // overlay bị ẩn — đúng lúc user cần chọn video khác nhất.
  // Picker tự theo dõi video nào đang được ghim (xem `VideoPicker.picked`) —
  // đồng bộ từ chính lần bấm của user, không suy ra từ `activeVideo`. Suy ra
  // từ `activeVideo` thì vòng `aria-current` bật lại ngay khi user bỏ ghim, vì
  // heuristic ưu tiên "video đang phát" và chọn đúng video vừa bỏ (Issue 5.27).
  picker.setVideos(videos);
  picker.position((activeVideo ?? videos[0]).getBoundingClientRect());

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

reconcile();

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
window.addEventListener(
  "scroll",
  () => {
    // `reconcile()` chỉ chạy khi có mutation DOM, còn video audio-only có thể
    // đổi từ ẩn sang hiện (hoặc ngược lại) chỉ vì layout đổi theo scroll/resize.
    // Không kiểm tra lại thì overlay kẹt ở trạng thái ẩn/sai chỗ (Issue 5.23).
    hideOverlayIfNowhereToShow();
    repositionOverlay();
    repositionPicker();
  },
  { capture: true, passive: true },
);
window.addEventListener("resize", () => {
  hideOverlayIfNowhereToShow();
  repositionOverlay();
  repositionPicker();
}, { passive: true });
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
