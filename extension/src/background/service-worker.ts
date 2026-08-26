// === BƯỚC 1: Lắng nghe sự kiện click vào Icon Extension trên thanh Toolbar ===
chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  void startCapture(tab.id).catch((error: unknown) => {
    console.error("Could not start captioning:", error);
  });
});

// === BƯỚC 2: Lắng nghe tin nhắn từ Content Script hoặc các trang nội bộ ===
chrome.runtime.onMessage.addListener((message, sender) => {
  // 2.1. Nhận yêu cầu kích hoạt từ nút "Enable Caption AI" của Content script
  if (message?.type === "start-captioning") {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;

    console.info(
      "Click the Caption AI toolbar icon to grant tab capture access.",
    );
    void startCapture(tabId);
  }

  // 2.2. Nhận mốc video.currentTime và chuyển tiếp (relay) sang cho Offscreen Document
  if (message?.type === "video-clock") {
    void chrome.runtime.sendMessage({
      type: "video-clock",
      videoTime: message.videoTime,
    });
  }
});

// === BƯỚC 3: Hàm thực hiện lấy Stream ID của Tab và kích hoạt Offscreen ===
async function startCapture(tabId: number) {
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

  // 3.2. Đảm bảo Offscreen Document đã được khởi tạo
  await ensureOffscreenDocument();
  await new Promise<void>((resolve) => setTimeout(resolve, 100));

  // 3.3. Gửi tin nhắn chứa streamId cho Offscreen Document bắt đầu ghi âm
  chrome.runtime.sendMessage({
    type: "start-audio-capture",
    streamId,
  });
}

// === BƯỚC 4: Khởi tạo Offscreen Document (tài liệu chạy ẩn) ===
async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({});
  const exists = contexts.some(
    (context) => context.contextType === "OFFSCREEN_DOCUMENT",
  );

  if (!exists) {
    await chrome.offscreen.createDocument({
      url: "dist/offscreen/offscreen.html",
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: "Capture tab audio for local transcription.",
    });
  }
}

