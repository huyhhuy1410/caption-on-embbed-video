import type { CaptionOverlay } from "./overlay";

type MovableNode = Node & {
  moveBefore?: (node: Node, child: Node | null) => void;
};

type FullscreenSession = {
  wrapper: HTMLDivElement;
  video: HTMLVideoElement;
  overlay: CaptionOverlay;
  parent: Node;
  before: Node | null;
  videoStyle: string;
  videoMoved: boolean;
  overlayParent: Node | null;
  overlayBefore: Node | null;
  overlayStyle: string;
  root: Document | ShadowRoot;
};

function moveNode(parent: Node, node: Node, before: Node | null): void {
  const sibling = before !== node && before?.parentNode === parent ? before : null;
  const movable = parent as MovableNode;
  // moveBefore preserves media state; insertBefore is fallback for older Chrome or detached nodes.
  if (parent.isConnected && node.isConnected && movable.moveBefore) {
    try {
      movable.moveBefore(node, sibling);
      return;
    } catch {
      // Different roots or browser doesn't support this move operation.
    }
  }
  parent.insertBefore(node, sibling);
}

function videoContentRect(video: HTMLVideoElement): DOMRect {
  const box = video.getBoundingClientRect();
  if (!video.videoWidth || !video.videoHeight || !box.width || !box.height) return box;
  const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
  const width = video.videoWidth * scale;
  const height = video.videoHeight * scale;
  return new DOMRect(box.left + (box.width - width) / 2, box.top + (box.height - height) / 2, width, height);
}

export class CaptionFullscreen {
  private session: FullscreenSession | null = null;
  private targetVideo: HTMLVideoElement | null = null;
  private targetOverlay: CaptionOverlay | null = null;
  private button: HTMLButtonElement | null = null;
  private observer: MutationObserver | null = null;
  private readonly onFullscreenChange = (): void => this.handleFullscreenChange();
  private readonly onViewportResize = (): void => this.repositionOverlay();

  isActive(): boolean {
    return this.session !== null;
  }

  setTarget(video: HTMLVideoElement, overlay: CaptionOverlay): void {
    // New target must not steal video from a running fullscreen session.
    if (this.session && (video !== this.session.video || overlay !== this.session.overlay)) {
      this.exit();
    }
    this.targetVideo = video;
    this.targetOverlay = overlay;
    this.mountButton(overlay);
  }

  repositionOverlay(force = false): void {
    const session = this.session;
    if (session?.video.isConnected) {
      session.overlay.position(videoContentRect(session.video), force);
    }
  }

  recoverIfBroken(): void {
    const session = this.session;
    if (!session) return;
    if (!session.wrapper.isConnected || !session.parent.isConnected ||
        session.wrapper.parentNode !== session.parent ||
        session.video.parentNode !== session.wrapper || !session.video.isConnected) {
      this.exit();
    }
  }

  async enter(): Promise<void> {
    const video = this.targetVideo;
    const overlay = this.targetOverlay;
    if (this.session || !video?.isConnected || !overlay || !video.parentNode) return;
    const root = video.getRootNode();
    if (!(root instanceof Document || root instanceof ShadowRoot)) return;
    const wrapper = document.createElement("div");
    const rect = video.getBoundingClientRect();
    wrapper.style.cssText = `position:relative;width:${rect.width}px;height:${rect.height}px;background:#000;overflow:hidden;`;
    const session: FullscreenSession = {
      wrapper, video, overlay, parent: video.parentNode, before: video.nextSibling,
      videoStyle: video.style.cssText, videoMoved: false, overlayParent: overlay.element.parentNode,
      overlayBefore: overlay.element.nextSibling, overlayStyle: overlay.element.style.cssText, root,
    };
    this.session = session;
    try {
      moveNode(session.parent, wrapper, video);
      video.style.cssText = "display:block;width:100%;height:100%;object-fit:contain;";
      moveNode(wrapper, video, null);
      session.videoMoved = true;
      // Top layer doesn't render overlay outside fullscreen element.
      moveNode(wrapper, overlay.element, null);
      wrapper.addEventListener("fullscreenchange", this.onFullscreenChange);
      document.addEventListener("fullscreenchange", this.onFullscreenChange);
      window.addEventListener("resize", this.onViewportResize, { passive: true });
      this.observer = new MutationObserver(() => this.recoverIfBroken());
      this.observer.observe(document, { childList: true, subtree: true });
      let ancestorRoot: Node = root;
      while (ancestorRoot instanceof ShadowRoot) {
        this.observer.observe(ancestorRoot, { childList: true, subtree: true });
        ancestorRoot = ancestorRoot.host.getRootNode();
      }
      this.setButtonLabel();
      await wrapper.requestFullscreen();
    } catch (error) {
      console.warn("Caption AI: fullscreen request failed", error);
      // Old promise may reject after dispose + enter; don't clean up new session.
      if (this.session === session) this.restore(session);
    }
  }

  private ownsFullscreen(session: FullscreenSession): boolean {
    // Document retargets fullscreenElement to host when wrapper is in shadow root.
    return session.root.fullscreenElement === session.wrapper;
  }

  private mountButton(overlay: CaptionOverlay): void {
    if (this.button?.getRootNode() === overlay.element.shadowRoot) return;
    this.button?.remove();
    this.button = null;
    if (!overlay.element.shadowRoot) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cc-fullscreen-btn";
    // Inline style ensures the icon displays properly if the page overrides button styles
    button.style.cssText = "display: flex; align-items: center; justify-content: center; font-size: 16px; width: 24px; height: 24px; line-height: 1; padding: 0; background: rgba(0, 0, 0, 0.5); color: white; border: 1px solid rgba(255, 255, 255, 0.3); border-radius: 4px; cursor: pointer; backdrop-filter: blur(4px); box-sizing: border-box;";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.isActive()) this.exit();
      else void this.enter();
    });
    overlay.mountToolbarButton(button);
    this.button = button;
    this.setButtonLabel();
  }

  private setButtonLabel(): void {
    if (!this.button) return;
    const active = this.isActive();
    this.button.textContent = active ? "✖" : "⛶";
    this.button.title = active ? "Exit fullscreen" : "Caption fullscreen";
    this.button.setAttribute("aria-label", active ? "Exit caption fullscreen" : "Enter caption fullscreen");
    this.button.setAttribute("aria-pressed", String(active));
  }

  private exit(): void {
    const session = this.session;
    if (!session) return;
    if (this.ownsFullscreen(session)) {
      void document.exitFullscreen().catch(() => {});
    }
    // Clean up even if browser doesn't fire fullscreenchange for detached subtree.
    this.restore(session);
  }

  private handleFullscreenChange(): void {
    const session = this.session;
    if (!session) return;
    if (this.ownsFullscreen(session)) {
      session.wrapper.style.width = "100%";
      session.wrapper.style.height = "100%";
      this.repositionOverlay(true);
    } else {
      this.restore(session);
    }
  }

  private restore(session: FullscreenSession): void {
    if (this.session !== session) return;
    this.session = null;
    this.observer?.disconnect();
    this.observer = null;
    session.wrapper.removeEventListener("fullscreenchange", this.onFullscreenChange);
    document.removeEventListener("fullscreenchange", this.onFullscreenChange);
    window.removeEventListener("resize", this.onViewportResize);
    const { wrapper, video, overlay, parent } = session;
    const ownsVideo = video.parentNode === wrapper;
    if (ownsVideo || (!session.videoMoved && video.parentNode === parent)) {
      video.style.cssText = session.videoStyle;
    }
    if (ownsVideo && wrapper.isConnected && parent.isConnected && wrapper.parentNode === parent) {
      moveNode(parent, video, session.before);
    }
    // If SPA removed wrapper/parent, drop video with them — don't resurrect into new page.
    if (overlay.element.parentNode === wrapper) {
      overlay.element.style.cssText = session.overlayStyle;
      const destination = session.overlayParent?.isConnected ? session.overlayParent : document.body;
      if (destination) moveNode(destination, overlay.element, session.overlayBefore);
      if (video.isConnected && video.parentNode === parent) {
        overlay.resetToVideoAnchor();
        overlay.position(video.getBoundingClientRect(), true);
      }
    }
    wrapper.remove();
    this.setButtonLabel();
  }

  dispose(): void {
    this.exit();
    this.button?.remove();
    this.button = null;
    this.targetVideo = null;
    this.targetOverlay = null;
  }
}
