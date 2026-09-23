import type { CaptionOverlay } from "./overlay";

/**
 * "CC fullscreen" wrapper — AC-5.3 / FR-4.5.
 *
 * Fullscreen đẩy element lên top layer, trên cả root stacking context: overlay
 * nằm ở document.body sẽ không được vẽ, z-index không cứu được. Nên video và
 * overlay phải nằm chung một wrapper, và chính wrapper đó đi fullscreen.
 */
type MovableNode = Node & {
  moveBefore?: (node: Node, child: Node | null) => void;
};

/** `before` chỉ dùng được khi còn là con của `parent`; SPA có thể đã gỡ nó. */
function validBefore(parent: Node, node: Node, before: Node | null): Node | null {
  if (before === null || before === node) return null;
  return before.parentNode === parent ? before : null;
}

/**
 * Cho node chưa nằm trong document. `moveBefore` là phép di chuyển, không phải
 * phép chèn — ném HierarchyRequestError khi node đang rời.
 */
function insertNode(parent: Node, node: Node, before: Node | null): void {
  parent.insertBefore(node, validBefore(parent, node, before));
}

/**
 * Cho node đã nằm trong document. `moveBefore` nguyên tử nên pause steps của
 * media element không chạy. Fallback `insertBefore` cũng an toàn: xoá và chèn
 * trong cùng một task, pause steps thoát sớm nếu element đã về lại document.
 */
function moveNode(parent: Node, node: Node, before: Node | null): void {
  const movable = parent as MovableNode;
  if (typeof movable.moveBefore === "function") {
    try {
      movable.moveBefore(node, validBefore(parent, node, before));
      return;
    } catch (error) {
      console.warn("Caption AI: moveBefore failed, falling back", error);
    }
  }
  parent.insertBefore(node, validBefore(parent, node, before));
}

/**
 * Vùng ảnh thật của video sau khi `object-fit: contain` letterbox.
 *
 * Fullscreen kéo element thành 100%×100% nên getBoundingClientRect trả element
 * box phủ kín màn hình, còn ảnh chỉ chiếm một dải giữa — neo caption vào đó là
 * caption rơi xuống vệt đen.
 */
function videoContentRect(video: HTMLVideoElement): DOMRect {
  const box = video.getBoundingClientRect();
  const intrinsicWidth = video.videoWidth;
  const intrinsicHeight = video.videoHeight;
  if (!intrinsicWidth || !intrinsicHeight || !box.width || !box.height) {
    return box;
  }
  const scale = Math.min(box.width / intrinsicWidth, box.height / intrinsicHeight);
  const width = intrinsicWidth * scale;
  const height = intrinsicHeight * scale;
  return new DOMRect(
    box.left + (box.width - width) / 2,
    box.top + (box.height - height) / 2,
    width,
    height,
  );
}

export class CaptionFullscreen {
  /** Chỉ non-null khi đang ở CC fullscreen. */
  private wrapper: HTMLDivElement | null = null;

  /** Ref, không phải bảo đảm — SPA có thể thay element bất cứ lúc nào. */
  private targetVideo: HTMLVideoElement | null = null;
  private targetOverlay: CaptionOverlay | null = null;

  /** Điểm khôi phục, ghi lúc enter. Cần cả nextSibling để về đúng vị trí. */
  private savedParent: Node | null = null;
  private savedNextSibling: Node | null = null;
  private savedVideoStyle: string | null = null;
  private savedOverlayStyle: string | null = null;

  private button: HTMLButtonElement | null = null;

  private readonly onFullscreenChange = (): void =>
    this.handleFullscreenChange();

  private readonly onViewportResize = (): void => this.repositionOverlay();

  isActive(): boolean {
    return this.wrapper !== null;
  }

  repositionOverlay(): void {
    const video = this.targetVideo;
    const overlay = this.targetOverlay;
    if (!this.wrapper || !video || !overlay) return;
    overlay.position(videoContentRect(video));
  }

  /**
   * Trỏ wrapper vào video hiện tại. Gọi từ reconcile() mỗi khi activeVideo đổi,
   * để nút toggle tồn tại trước khi user cần bấm.
   */
  setTarget(video: HTMLVideoElement, overlay: CaptionOverlay): void {
    this.targetVideo = video;
    this.targetOverlay = overlay;
    this.mountButton(overlay);
  }

  /**
   * Dọn phiên fullscreen đã hỏng: wrapper hoặc video rời document. Không có
   * fullscreenchange nào nổ cho việc đó, và reconcile() không đổi target khi
   * đang active, nên không còn đường nào khác dọn.
   */
  recoverIfBroken(): void {
    if (!this.wrapper) return;
    if (!this.wrapper.isConnected) {
      this.restore();
      return;
    }
    if (!this.targetVideo || !this.targetVideo.isConnected) {
      this.restore();
    }
  }

  /**
   * Vào CC fullscreen. Mọi thao tác DOM bên dưới chạy trong một task, không có
   * await xen giữa lúc video rời parent và lúc nó vào wrapper — xem moveNode().
   * Await duy nhất là requestFullscreen ở cuối, phải còn trong task của handler
   * click mới tính là user gesture.
   */
  async enter(): Promise<void> {
    const video = this.targetVideo;
    const overlay = this.targetOverlay;

    if (this.wrapper !== null || !video || !overlay || !video.isConnected) {
      return;
    }

    this.savedParent = video.parentNode;
    this.savedNextSibling = video.nextSibling;
    this.savedVideoStyle = video.style.cssText;
    this.savedOverlayStyle = overlay.element.style.cssText;

    if (!this.savedParent) {
      this.savedNextSibling = null;
      this.savedVideoStyle = null;
      this.savedOverlayStyle = null;
      return;
    }

    const rect = video.getBoundingClientRect();

    // this.wrapper được gán trước khi dựng xong DOM, nên lỗi giữa chừng sẽ để
    // nó non-null mà chưa dời gì — và guard ở trên chặn luôn mọi lần bấm sau.
    let wrapper: HTMLDivElement;
    try {
      wrapper = document.createElement("div");
      wrapper.style.cssText = `
        position: relative;
        width: ${rect.width}px;
        height: ${rect.height}px;
        background: #000;
        overflow: hidden;
      `;
      this.wrapper = wrapper;

      insertNode(this.savedParent, wrapper, this.savedNextSibling);

      // Size tường minh: rule của site (`.player > video { ... }`) có thể không
      // còn match sau khi video đổi parent.
      video.style.cssText =
        "display:block; width:100%; height:100%; object-fit:contain;";
      moveNode(wrapper, video, null);

      // Element fullscreen trở thành containing block cho position:fixed con
      // cháu nó — đó là lý do overlay phải vào đây. Đặt vị trí thật sự ở
      // handleFullscreenChange, khi layout đã ổn định.
      wrapper.appendChild(overlay.element);

      document.addEventListener("fullscreenchange", this.onFullscreenChange);
      window.addEventListener("resize", this.onViewportResize, { passive: true });
    } catch (error) {
      console.warn("Caption AI: could not build fullscreen wrapper", error);
      this.restore();
      return;
    }

    try {
      await wrapper.requestFullscreen();
    } catch (error) {
      console.warn("Caption AI: fullscreen request rejected", error);
      this.restore();
    }
  }

  /**
   * Nút nằm trong shadow root của overlay để đi theo overlay vào wrapper. Đặt ở
   * document.body thì nó ở lại ngoài và biến mất trong fullscreen — đúng vấn đề
   * lớp này sinh ra để giải quyết.
   *
   * Là flex child chứ không absolute: :host co theo nội dung, nên offset tuyệt
   * đối sẽ đè lên chữ caption.
   */
  private mountButton(overlay: CaptionOverlay): void {
    if (this.button && this.button.isConnected) return;

    const shadow = overlay.element.shadowRoot;
    if (!shadow) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "cc-fullscreen-btn";
    // :host đang pointer-events:none, nút phải tự bật lại.
    button.style.cssText = `
      align-self: flex-end;
      pointer-events: auto;
      margin-right: 4px;
      padding: 3px 8px;
      font: inherit;
      font-size: 11px;
      line-height: 1.2;
      background: rgba(0, 0, 0, 0.7);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.35);
      border-radius: 4px;
      cursor: pointer;
      white-space: nowrap;
    `;

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.isActive()) {
        this.exit();
      } else {
        void this.enter();
      }
    });

    shadow.appendChild(button);
    this.button = button;
    this.setButtonLabel();
  }

  private setButtonLabel(): void {
    if (!this.button) return;
    this.button.textContent = this.isActive() ? "Thoát CC" : "CC fullscreen";
  }

  private exit(): void {
    if (!this.wrapper) return;
    if (document.fullscreenElement === this.wrapper) {
      void document.exitFullscreen().catch(() => {
        this.restore();
      });
    } else {
      // Browser đã thoát (ESC), chỉ còn DOM chưa dọn.
      this.restore();
    }
  }

  /**
   * Nổ ở cả chiều vào lẫn chiều ra. restore() gỡ chính listener này, nên event
   * do exitFullscreen() sinh ra không thể quay lại đây lần hai.
   */
  private handleFullscreenChange(): void {
    const wrapper = this.wrapper;
    // Phải guard wrapper: khi cả hai đều null thì phép so dưới là true.
    if (wrapper !== null && document.fullscreenElement === wrapper) {
      wrapper.style.width = "100%";
      wrapper.style.height = "100%";
      // Lúc này layout fullscreen mới áp. Gọi trong enter() sẽ đo nhầm box cũ,
      // còn vòng rAF chỉ chạy khi video đang phát.
      this.repositionOverlay();
      this.setButtonLabel();
      return;
    }

    if (wrapper !== null) {
      this.restore();
    }
  }

  /**
   * Trả video và overlay về chỗ cũ rồi bỏ wrapper. Video phải ra khỏi wrapper
   * trước khi wrapper bị xoá, không thì nó bị rời document theo và pause steps
   * chạy.
   */
  private restore(): void {
    const wrapper = this.wrapper;
    const video = this.targetVideo;
    const overlay = this.targetOverlay;
    if (!wrapper) return;

    // Vô điều kiện: enter() ghi đè inline style của video trước khi dời nó, nên
    // lỗi ở khoảng giữa sẽ làm mất style gốc của site.
    if (video && this.savedVideoStyle !== null) {
      video.style.cssText = this.savedVideoStyle;
    }

    // Chỉ dời về nếu nó vẫn là của mình; SPA có thể đã lấy đi rồi.
    if (video && video.parentNode === wrapper) {
      if (this.savedParent && this.savedParent.isConnected) {
        moveNode(this.savedParent, video, this.savedNextSibling);
      } else {
        video.remove();
      }
    }

    // Overlay đang là con của wrapper, xoá wrapper là nó rời document theo.
    if (overlay && overlay.element.parentNode === wrapper) {
      overlay.element.style.cssText = this.savedOverlayStyle ?? "";
      document.body.appendChild(overlay.element);
      // Về layout thường, và không có gì reposition khi video đang pause.
      if (video) {
        overlay.position(video.getBoundingClientRect());
      }
    }

    wrapper.remove();

    document.removeEventListener("fullscreenchange", this.onFullscreenChange);
    window.removeEventListener("resize", this.onViewportResize);
    this.wrapper = null;
    this.savedParent = null;
    this.savedNextSibling = null;
    this.savedVideoStyle = null;
    this.savedOverlayStyle = null;
    this.setButtonLabel();
  }

  dispose(): void {
    if (this.wrapper) {
      if (document.fullscreenElement === this.wrapper) {
        void document.exitFullscreen().catch(() => {});
      }
      this.restore();
    }
    document.removeEventListener("fullscreenchange", this.onFullscreenChange);

    this.button?.remove();
    this.button = null;
    this.targetVideo = null;
    this.targetOverlay = null;
  }
}
