/**
 * Chip chọn video khi trang có nhiều `<video>` — FR-1.3.
 *
 * Đứng RIÊNG ngoài shadow root của overlay: overlay neo theo hộp video đang
 * chọn, mà video audio-only có hộp 0×0 (Issue 5.23) nên overlay bị ẩn — nhét
 * picker vào đó là nó biến mất đúng lúc cần nhất.
 */
type ShadowHost = HTMLElement & { shadowRoot: ShadowRoot | null };

/** Khoảng cách tới mép video / mép viewport (px). */
const GAP_PX = 8;

export class VideoPicker {
  private host: HTMLDivElement;
  private shadow: ShadowRoot;
  private chip: HTMLButtonElement;
  private panel: HTMLDivElement;
  private list: HTMLDivElement;
  private renderedIds: string[] = [];
  private videosRef: HTMLVideoElement[] = [];

  /** Video user ghim, `null` = đang theo heuristic. */
  private picked: HTMLVideoElement | null = null;
  private expanded = false;
  private userPositioned = false;
  private lastAnchorRect: DOMRect | null = null;
  private suppressClick = false;
  private drag: {
    pointerId: number;
    startX: number;
    startY: number;
    originLeft: number;
    originTop: number;
    moved: boolean;
  } | null = null;

  private readonly onDocumentPointerDown = (event: Event): void => {
    if (!this.expanded) return;
    // `composedPath` xuyên shadow DOM; `event.target` thì bị retarget về host.
    if (event.composedPath().includes(this.host)) return;
    this.setExpanded(false);
  };

  constructor(
    private readonly anchor: ShadowHost,
    private readonly onPick: (video: HTMLVideoElement) => void,
  ) {
    this.host = document.createElement("div");
    this.shadow = this.host.attachShadow({ mode: "open" });
    this.chip = document.createElement("button");
    this.panel = document.createElement("div");
    this.list = document.createElement("div");

    const style = document.createElement("style");
    style.textContent = `
:host {
  position: fixed;
  z-index: 99999999;
  display: none;
  font-family: system-ui, sans-serif;
  /* Không chắn chuột: chỉ chip và panel tự bật lại. */
  pointer-events: none;
}
.chip {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  font: inherit;
  font-size: 11px;
  line-height: 1.4;
  color: #fff;
  background: rgba(0, 0, 0, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.28);
  border-radius: 999px;
  cursor: grab;
  white-space: nowrap;
  touch-action: none;
}
.chip:active {
  cursor: grabbing;
}
.chip:hover {
  background: rgba(0, 0, 0, 0.88);
}
.chip .caret {
  opacity: 0.7;
  font-size: 9px;
}
.panel {
  pointer-events: auto;
  display: none;
  flex-direction: column;
  gap: 3px;
  margin-top: 5px;
  padding: 6px;
  max-width: 240px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.14);
}
:host([data-expanded="true"]) .panel {
  display: flex;
}
.label {
  color: rgba(255, 255, 255, 0.6);
  font-size: 10px;
  padding: 0 3px 2px;
}
.item {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 7px;
  font: inherit;
  font-size: 11px;
  text-align: left;
  color: #fff;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 5px;
  cursor: pointer;
}
.item:hover {
  background: rgba(255, 255, 255, 0.2);
}
/* Nền đậm + viền, không chỉ đổi màu chữ — khác biệt màu đơn thuần dễ bị bỏ sót. */
.item[aria-current="true"] {
  background: rgba(79, 195, 247, 0.26);
  border-color: #4fc3f7;
}
.name {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag {
  flex: 0 0 auto;
  color: rgba(255, 255, 255, 0.65);
  font-size: 10px;
}
`;

    this.chip.type = "button";
    this.chip.className = "chip";
    this.panel.className = "panel";
    this.chip.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      this.setExpanded(!this.expanded);
    });
    this.chip.addEventListener("dblclick", () => {
      this.userPositioned = false;
      if (this.lastAnchorRect) this.position(this.lastAnchorRect);
    });
    this.installChipDrag();

    this.panel.appendChild(this.list);
    this.shadow.append(style, this.chip, this.panel);
    document.body.appendChild(this.host);
  }

  private installChipDrag(): void {
    this.chip.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const rect = this.host.getBoundingClientRect();
      this.drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originLeft: rect.left,
        originTop: rect.top,
        moved: false,
      };
      this.chip.setPointerCapture(event.pointerId);
    });

    this.chip.addEventListener("pointermove", (event) => {
      const drag = this.drag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      event.preventDefault();
      this.moveTo(drag.originLeft + dx, drag.originTop + dy);
    });

    const release = (event: PointerEvent): void => {
      const drag = this.drag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      this.suppressClick = drag.moved;
      this.drag = null;
      this.chip.releasePointerCapture?.(event.pointerId);
    };
    this.chip.addEventListener("pointerup", release);
    this.chip.addEventListener("pointercancel", release);
    this.chip.addEventListener("lostpointercapture", release);
  }

  /** Vẽ lại danh sách. Danh sách không đổi thì chỉ cập nhật mục đang ghim. */
  setVideos(videos: HTMLVideoElement[]): void {
    // Video đã ghim bị SPA gỡ thì thôi ghim — `reconcile()` cũng rơi về heuristic.
    if (this.picked && !videos.includes(this.picked)) this.picked = null;

    if (videos.length < 2) {
      this.clear();
      return;
    }

    const ids = videos.map((v, i) => `${indexOf(v)}:${i}`);
    if (ids.join() !== this.renderedIds.join()) {
      this.renderedIds = ids;
      this.render(videos);
    } else {
      this.markActive();
    }
    this.updateChip(videos);
    this.host.style.display = "block";
  }

  /**
   * Neo chip vào mép video đang chọn; video 0×0 thì lùi về góc viewport vì
   * không có hộp nào để bám (video audio-only vẫn cần picker — Issue 5.23).
   */
  position(rect: DOMRect): void {
    this.lastAnchorRect = rect;
    if (this.userPositioned && this.drag === null) return;

    const width = this.host.offsetWidth || 120;
    const height = this.host.offsetHeight || 24;

    let left: number;
    let top: number;
    if (rect.width > 0 && rect.height > 0) {
      if (rect.left - GAP_PX - width >= GAP_PX) {
        // Bên trái video, ngang mép trên — tránh chỗ panel caption đang chiếm.
        left = rect.left - GAP_PX - width;
        top = rect.top + GAP_PX;
      } else {
        left = rect.left + GAP_PX;
        top = rect.bottom - height - GAP_PX;
      }
    } else {
      left = GAP_PX;
      top = GAP_PX;
    }

    const maxLeft = window.innerWidth - width - GAP_PX;
    const maxTop = window.innerHeight - height - GAP_PX;
    this.host.style.left = `${Math.round(Math.min(Math.max(left, GAP_PX), Math.max(GAP_PX, maxLeft)))}px`;
    this.host.style.top = `${Math.round(Math.min(Math.max(top, GAP_PX), Math.max(GAP_PX, maxTop)))}px`;
  }

  private moveTo(left: number, top: number): void {
    const rect = this.host.getBoundingClientRect();
    const width = rect.width || 120;
    const height = rect.height || 24;
    const maxLeft = Math.max(GAP_PX, window.innerWidth - width - GAP_PX);
    const maxTop = Math.max(GAP_PX, window.innerHeight - height - GAP_PX);
    this.host.style.left = `${Math.round(Math.min(Math.max(left, GAP_PX), maxLeft))}px`;
    this.host.style.top = `${Math.round(Math.min(Math.max(top, GAP_PX), maxTop))}px`;
    this.userPositioned = true;
  }

  private updateChip(videos: HTMLVideoElement[]): void {
    const name = this.picked ? describeVideo(this.picked) : null;
    this.chip.textContent = "";
    const text = document.createElement("span");
    text.textContent = name ?? `${videos.length} video`;
    const caret = document.createElement("span");
    caret.className = "caret";
    caret.textContent = this.expanded ? "▲" : "▼";
    this.chip.append(text, caret);
    this.chip.title = "Chọn video để tạo phụ đề";
  }

  private setExpanded(next: boolean): void {
    if (next === this.expanded) return;
    this.expanded = next;
    if (next) {
      this.host.dataset.expanded = "true";
      document.addEventListener("pointerdown", this.onDocumentPointerDown, true);
    } else {
      delete this.host.dataset.expanded;
      document.removeEventListener("pointerdown", this.onDocumentPointerDown, true);
    }
    const videos = this.videosRef;
    if (videos.length > 0) this.updateChip(videos);
  }

  private render(videos: HTMLVideoElement[]): void {
    this.list.textContent = "";
    this.videosRef = videos;

    for (let index = 0; index < videos.length; index++) {
      const video = videos[index];
      const item = document.createElement("button");
      item.type = "button";
      item.className = "item";
      item.dataset.index = String(index);

      const name = document.createElement("span");
      name.className = "name";
      name.textContent = describeVideo(video);

      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = videoTag(video);

      item.append(name, tag);
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        // Bấm lại video đã ghim thì giữ nguyên: `reconcile()` ưu tiên "video
        // đang phát" nên bỏ ghim xong nó chọn lại chính video đó.
        if (video !== this.picked) {
          this.picked = video;
          this.onPick(video);
        }
        // `markActive` chỉ chạy lúc dựng danh sách, nên phải gọi lại ở đây —
        // không thì mục vừa chọn vẫn hiện là chưa chọn.
        this.markActive();
        this.setExpanded(false);
      });
      this.list.appendChild(item);
    }
    this.markActive();
  }

  private markActive(): void {
    for (const node of Array.from(this.list.querySelectorAll("button"))) {
      const index = Number(node.getAttribute("data-index"));
      const video = Number.isInteger(index) ? this.videosRef[index] ?? null : null;
      if (video === this.picked) {
        node.setAttribute("aria-current", "true");
      } else {
        node.removeAttribute("aria-current");
      }
    }
  }

  clear(): void {
    this.setExpanded(false);
    this.host.style.display = "none";
    this.renderedIds = [];
    this.videosRef = [];
    this.list.textContent = "";
  }

  dispose(): void {
    this.setExpanded(false);
    this.host.remove();
  }
}

/** Nhãn rút gọn từ `src`, đủ để phân biệt hai video. */
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

/** Nhãn phụ: đang phát / chỉ audio. */
function videoTag(video: HTMLVideoElement): string {
  if (!video.paused && !video.ended) return "đang phát";
  return isVisible(video) ? "" : "chỉ audio";
}

/**
 * Video có vùng hiển thị thật không — câu hỏi THỊ GIÁC, khác `paused`: video
 * 0×0 vẫn phát ra tiếng và vẫn được transcribe (Issue 5.23).
 */
export function isVisible(video: HTMLVideoElement): boolean {
  const rect = video.getBoundingClientRect();
  // `offsetWidth/Height` bắt `display:none` (rect toàn 0), rect bắt video bị
  // thu nhỏ bằng transform — cần cả hai.
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    (video.offsetWidth > 0 || video.offsetHeight > 0)
  );
}

function indexOf(video: HTMLVideoElement): number {
  return Array.from(document.querySelectorAll("video")).indexOf(video);
}
