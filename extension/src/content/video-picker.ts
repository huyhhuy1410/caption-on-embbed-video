/**
 * Thanh chọn video khi trang có nhiều `<video>` — FR-1.3.
 *
 * ⚠️ Cố ý đứng RIÊNG, không nằm trong shadow root của overlay: overlay được neo
 * theo hộp của video đang chọn, mà video audio-only có hộp 0×0 (Issue 5.23) —
 * lúc đó overlay bị ẩn theo quyết định thiết kế, và picker nằm trong đó sẽ
 * biến mất đúng lúc user cần nó nhất. Đặt ở `document.body` với toạ độ neo
 * viewport thì picker luôn tới được, kể cả khi video được chọn không có hình.
 *
 * Đánh đổi: không theo vào CC fullscreen (ngoài fullscreen element thì không
 * hiện được). Chấp nhận được vì trong fullscreen đang xem đúng một video.
 */
type ShadowHost = HTMLElement & { shadowRoot: ShadowRoot | null };

export class VideoPicker {
  private host: HTMLDivElement;
  private shadow: ShadowRoot;
  private bar: HTMLDivElement;
  /** Số video ở lần dựng gần nhất — dùng để chỉ dựng lại khi thực sự đổi. */
  private renderedIds: string[] = [];

  /** Danh sách video đã dựng, giữ để `markActive` tra ngược. */
  private videosRef: HTMLVideoElement[] = [];

  constructor(
    private readonly anchor: ShadowHost,
    private readonly onPick: (video: HTMLVideoElement) => void,
  ) {
    this.host = document.createElement("div");
    this.shadow = this.host.attachShadow({ mode: "open" });
    this.bar = document.createElement("div");

    const style = document.createElement("style");
    style.textContent = `
:host {
  position: fixed;
  top: 8px;
  left: 8px;
  z-index: 99999999;
  display: none;
  font-family: system-ui, sans-serif;
}
.bar {
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 220px;
  padding: 6px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.78);
  color: #fff;
  font-size: 11px;
  line-height: 1.2;
}
.label {
  opacity: 0.75;
  padding: 0 2px 2px;
}
button {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  font: inherit;
  font-size: 11px;
  text-align: left;
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 4px;
  cursor: pointer;
}
button:hover {
  background: rgba(255, 255, 255, 0.22);
}
/* Video đang được chọn — nền đậm hơn, không chỉ khác màu chữ vì người dùng
   có thể không phân biệt được màu. */
button[aria-current="true"] {
  background: rgba(79, 195, 247, 0.28);
  border-color: #4fc3f7;
}
.tag {
  opacity: 0.7;
  font-size: 10px;
}
`;

    this.shadow.appendChild(style);
    this.shadow.appendChild(this.bar);
    document.body.appendChild(this.host);
  }

  /**
   * Vẽ lại thanh chọn.
   *
   * `onPick` được gọi kèm chính element video, không phải chỉ số: chỉ số đổi
   * mỗi lần `reconcile()` quét lại DOM, còn element thì bám đúng video.
   */
  setVideos(videos: HTMLVideoElement[], active: HTMLVideoElement | null): void {
    // 0 hoặc 1 video thì không có gì để chọn — ẩn hẳn cho khỏi che.
    if (videos.length < 2) {
      this.clear();
      return;
    }

    const ids = videos.map((v, i) => `${indexOf(v)}:${i}`);
    if (ids.join() !== this.renderedIds.join()) {
      this.renderedIds = ids;
      this.render(videos, active);
    } else {
      // Danh sách không đổi, chỉ cần cập nhật video nào đang được chọn.
      this.markActive(active);
    }
    this.host.style.display = "block";
  }

  private render(
    videos: HTMLVideoElement[],
    active: HTMLVideoElement | null,
  ): void {
    this.bar.textContent = "";
    this.videosRef = videos;

    const label = document.createElement("div");
    label.className = "label";
    label.textContent = `Chọn video (${videos.length})`;
    this.bar.appendChild(label);

    for (const video of videos) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.index = String(videos.indexOf(video));

      const name = document.createElement("span");
      name.textContent = describeVideo(video);

      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = videoTag(video);

      button.appendChild(name);
      button.appendChild(tag);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.onPick(video);
      });
      this.bar.appendChild(button);
    }
    this.markActive(active);
  }

  private markActive(active: HTMLVideoElement | null): void {
    for (const node of Array.from(this.bar.querySelectorAll("button"))) {
      const index = Number(node.getAttribute("data-index"));
      const video = Number.isInteger(index) ? this.videoAt(index) : null;
      if (video === active) {
        node.setAttribute("aria-current", "true");
      } else {
        node.removeAttribute("aria-current");
      }
    }
  }

  /** Khớp lại video theo thứ tự đã dựng — xem `setVideos`. */
  private videoAt(index: number): HTMLVideoElement | null {
    return this.videosRef[index] ?? null;
  }

  clear(): void {
    this.host.style.display = "none";
    this.renderedIds = [];
    this.videosRef = [];
  }

  dispose(): void {
    this.host.remove();
  }
}

/** Nhãn rút gọn từ `src`, đủ để phân biệt hai video trong danh sách. */
function describeVideo(video: HTMLVideoElement): string {
  const current = video.currentSrc || video.src;
  if (!current) return "video (không rõ nguồn)";
  try {
    const url = new URL(current, window.location.href);
    const name = url.pathname.split("/").filter(Boolean).pop() ?? url.hostname;
    return name || url.hostname;
  } catch {
    return current.slice(0, 40);
  }
}

/** Nhãn phụ: đang phát / có hình / chỉ audio. */
function videoTag(video: HTMLVideoElement): string {
  if (!video.paused && !video.ended) return "đang phát";
  return isVisible(video) ? "" : "chỉ audio";
}

/**
 * Video có vùng hiển thị thật không.
 *
 * ⚠️ Đây là câu hỏi THỊ GIÁC, khác hẳn `paused` — nhiều trang dùng video 0×0
 * làm nguồn audio, và chúng VẪN phát ra tiếng (Issue 5.23).
 */
export function isVisible(video: HTMLVideoElement): boolean {
  const rect = video.getBoundingClientRect();
  // `offsetWidth/Height` bắt được video bị `display:none` (rect toàn 0), còn
  // rect bắt được video bị thu nhỏ bằng transform. Kiểm tra cả hai.
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    (video.offsetWidth > 0 || video.offsetHeight > 0)
  );
}

function indexOf(video: HTMLVideoElement): number {
  return Array.from(document.querySelectorAll("video")).indexOf(video);
}
