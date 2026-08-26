// === BƯỚC 1: Tìm kiếm các thẻ HTML <video> đang xuất hiện trên trang web ===
const videos = Array.from(document.querySelectorAll("video"));

if (videos.length > 0) {
  // Lấy video đầu tiên phát hiện trên trang
  const video = videos[0];

  // === BƯỚC 2: Tạo nút bấm Giao diện "Enable Caption AI" cố định ở góc màn hình ===
  const button = document.createElement("button");
  button.textContent = "Enable Caption AI";
  button.type = "button";
  Object.assign(button.style, {
    position: "fixed",
    top: "16px",
    right: "16px",
    zIndex: "2147483647",
    padding: "8px 12px",
    background: "#172554",
    color: "#fff",
    border: "1px solid #60a5fa",
    borderRadius: "6px",
    cursor: "pointer",
  });

  // === BƯỚC 3: Xử lý sự kiện khi Người dùng bấm bật Caption AI ===
  button.addEventListener("click", () => {
    // 3.1. Gửi thông điệp kích hoạt thu âm tới Background Service Worker
    chrome.runtime.sendMessage({ type: "start-captioning" });
    button.textContent = "Caption AI enabled";

    // 3.2. Định kỳ mỗi 500ms gửi mốc thời gian video.currentTime hiện tại cho Extension
    setInterval(() => {
      chrome.runtime.sendMessage({
        type: "video-clock",
        videoTime: video.currentTime,
      });
    }, 500);
  });

  // Chèn nút bấm vào DOM của trang web
  document.documentElement.append(button);
}

