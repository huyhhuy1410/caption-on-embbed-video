type MediaSource = { currentSrc: string; src: string };

export class SourceIdentity {
  private readonly sources = new WeakMap<MediaSource, { url: string; id: string }>();
  // Backend caches sourceId across sessions; local counter would collide between tabs.
  // getRandomValues works over HTTP, where randomUUID requires secure context.
  private readonly documentId = Array.from(crypto.getRandomValues(new Uint32Array(4)),
    value => value.toString(16).padStart(8, "0")).join("");
  private counter = 0;

  forVideo(video: MediaSource, pageUrl: string): string {
    // SPA may keep blob: URL but change video via page URL.
    const url = (video.currentSrc || video.src) + "@" + pageUrl;
    let entry = this.sources.get(video);
    if (!entry || entry.url !== url) {
      entry = { url, id: `${this.documentId}:v${++this.counter}` };
      this.sources.set(video, entry);
    }
    return entry.id;
  }

  invalidate(video: MediaSource): void {
    this.sources.delete(video);
  }
}
