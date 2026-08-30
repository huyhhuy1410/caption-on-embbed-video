console.info("Caption AI: content script loaded", window.location.href);
let captionEnabled = false;
function attachVideo(video: HTMLVideoElement) {
  if (video.dataset.captionAiTracked === "true") return;
  video.dataset.captionAiTracked = "true";
  console.info("Caption AI: tracking video", video);

  // Gửi video-clock theo sự kiện timeupdate (chỉ khi currentTime đổi),
  // thay cho setInterval 500ms — giảm tải message khi video không chạy.
  video.addEventListener("timeupdate", () => {
    if (!captionEnabled) return;
    void chrome.runtime
      .sendMessage({
        type: "video-clock",
        videoTime: video.currentTime,
      })
      .catch(() => {
        // Service worker may not be ready yet.
      });
  });

  video.addEventListener("seeked", () => {
    if (!captionEnabled) return;
    const message = {
      type: "seek",
      seekTimeAtCapture: video.currentTime,
    };
    console.info("Caption AI: video seeked", message);
    void chrome.runtime.sendMessage(message).catch((error: unknown) => {
      console.warn("Caption AI: could not send seek", error);
    });
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "capturing") {
      captionEnabled = true;
      const message = {
        type: "video-clock",
        videoTime: video.currentTime,
      };
      void chrome.runtime.sendMessage(message).catch((error: unknown) => {
        console.warn("Caption AI: could not send initial video clock", error);
      });
    }
  });
}

function findVideo() {
  return document.querySelector("video");
}

const initialVideo = findVideo();
console.info("Caption AI: videos found", initialVideo ? 1 : 0);

if (initialVideo) {
  attachVideo(initialVideo);
} else {
  // Chỉ quét lại khi mutation thực sự thêm node có thể chứa <video>.
  const observer = new MutationObserver((mutations) => {
    const hasPossibleVideo = mutations.some((mutation) =>
      Array.from(mutation.addedNodes).some(
        (node) =>
          node.nodeType === Node.ELEMENT_NODE &&
          ((node as Element).matches("video") ||
            (node as Element).querySelector("video") !== null),
      ),
    );

    if (!hasPossibleVideo) return;

    const video = findVideo();
    if (!video) return;

    observer.disconnect();
    console.info("Caption AI: videos found", 1);
    attachVideo(video);
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}
