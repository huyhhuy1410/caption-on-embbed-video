const SCAN_BUDGET = 256;
const PROBE_INTERVAL_MS = 250;
const OWNED_SELECTOR = "[data-caption-ai-owned]";

type Scan = { root: Node; walker: TreeWalker; first: boolean };

/** Open roots don't fire mutation on attachShadow; probe hosts in slices, no page patching. */
export class VideoDiscovery {
  private readonly roots = new Map<Document | ShadowRoot, MutationObserver>();
  private readonly elements = new Set<Element>();
  private readonly found = new Set<HTMLVideoElement>();
  private readonly scans = new Map<Node, Scan>();
  private probe: Iterator<Element> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private changed = false;

  constructor(
    private readonly onChange: () => void,
    private readonly ignoreHost: (host: Element) => boolean = () => false,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.observe(document);
    this.scheduleProbe();
  }

  videos(): HTMLVideoElement[] {
    return [...this.found].filter((video) => this.eligible(video));
  }

  dispose(): void {
    this.running = false;
    for (const observer of this.roots.values()) observer.disconnect();
    this.roots.clear();
    this.elements.clear();
    this.found.clear();
    this.scans.clear();
    this.probe = null;
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.scanTimer !== null) clearTimeout(this.scanTimer);
    this.timer = this.scanTimer = null;
    this.changed = false;
  }

  private ignored(element: Element): boolean {
    return element.matches(OWNED_SELECTOR) || this.ignoreHost(element);
  }

  private eligible(element: Element): boolean {
    if (!element.isConnected) return false;
    let current: Element | null = element;
    while (current) {
      if (this.ignored(current)) return false;
      const parent: Element | null = current.parentElement;
      const root = current.getRootNode();
      current = parent ?? (root instanceof ShadowRoot ? root.host : null);
    }
    return true;
  }

  private observe(root: Document | ShadowRoot): void {
    if (this.roots.has(root)) return;
    const observer = new MutationObserver((mutations) => {
      if (!this.running) return;
      for (const mutation of mutations) {
        if (mutation.type === "attributes") {
          const element = mutation.target as Element;
          if (this.eligible(element) &&
              (element.localName === "video" || element.localName === "source")) {
            this.changed = true;
          }
          continue;
        }
        for (const node of mutation.addedNodes) this.enqueue(node);
        // Clean up refs in removed subtrees using the same budget as new ones.
        for (const node of mutation.removedNodes) this.enqueue(node);
        if (mutation.target instanceof HTMLVideoElement && this.eligible(mutation.target)) {
          this.changed = true;
        }
      }
      this.prune();
      this.flush();
    });
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
    this.roots.set(root, observer);
    this.enqueue(root);
  }

  private enqueue(root: Node): void {
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE &&
        root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    if (this.scans.has(root)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (node) => this.ignored(node as Element)
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    this.scans.set(root, { root, walker, first: true });
    this.scheduleScan();
  }

  private scheduleScan(): void {
    if (!this.running || this.scanTimer !== null || !this.scans.size) return;
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      this.scanSlice();
    }, 0);
  }

  private scanSlice(): void {
    let budget = SCAN_BUDGET;
    while (budget-- > 0 && this.scans.size && this.running) {
      const scan = this.scans.values().next().value as Scan;
      let node: Node | null;
      if (scan.first && scan.root instanceof Element) {
        node = scan.root;
        scan.first = false;
        if (this.ignored(scan.root)) {
          this.scans.delete(scan.root);
          continue;
        }
      } else {
        scan.first = false;
        node = scan.walker.nextNode();
      }
      if (node === null) {
        this.scans.delete(scan.root);
        continue;
      }
      this.visit(node as Element);
    }
    this.flush();
    this.scheduleScan();
  }

  private visit(element: Element): void {
    if (!this.eligible(element)) {
      this.elements.delete(element);
      if (this.found.delete(element as HTMLVideoElement)) this.changed = true;
      return;
    }
    this.elements.add(element);
    if (element instanceof HTMLVideoElement && !this.found.has(element)) {
      this.found.add(element);
      this.changed = true;
    }
    if (element.shadowRoot) this.observe(element.shadowRoot);
  }

  private prune(): void {
    for (const [root, observer] of this.roots) {
      if (root instanceof ShadowRoot && !this.eligible(root.host)) {
        observer.disconnect();
        this.roots.delete(root);
        // Root left the tree; no more mutations, so scan separately to release internal refs.
        this.enqueue(root);
      }
    }
    for (const video of this.found) {
      if (!this.eligible(video)) {
        this.found.delete(video);
        this.changed = true;
      }
    }
  }

  private scheduleProbe(): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.running) return;
      this.prune();
      this.probe ??= this.elements.values();
      for (let i = 0; i < SCAN_BUDGET; i++) {
        const entry = this.probe.next();
        if (entry.done) {
          this.probe = null;
          break;
        }
        this.visit(entry.value);
      }
      this.flush();
      if (this.running) this.scheduleProbe();
    }, PROBE_INTERVAL_MS);
  }

  private flush(): void {
    if (!this.running || !this.changed) return;
    this.changed = false;
    this.onChange();
  }
}
