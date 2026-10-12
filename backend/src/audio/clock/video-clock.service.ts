import { Injectable } from '@nestjs/common';

@Injectable()
export class VideoClockService {
  /** Audio chunk duration in seconds (capture.ts: 16,000 samples @ 16kHz). */
  private static readonly CHUNK_SECONDS = 1.0;

  /** Previous chunk's `videoTimeAtCapture`. `undefined` = no chunk yet. */
  private previous: number | undefined;

  /**
   * @param currentVideoTime `videoTimeAtCapture` from offscreen
   * @returns video time at START of this audio chunk
   */
  resolveAnchor(currentVideoTime: number): number {
    // No prior sample (first chunk, or just reset): infer the chunk's start from the
    // current time. A prior sample is already the start of THIS chunk — reusing it is
    // what keeps the anchor from drifting.
    const anchor =
      this.previous !== undefined
        ? this.previous
        : currentVideoTime - VideoClockService.CHUNK_SECONDS;

    // Assign AFTER computing the anchor: the stored value must stay one chunk behind.
    this.previous = currentVideoTime;
    return anchor;
  }

  /** Clear state — call on seek. */
  reset(): void {
    this.previous = undefined;
  }
}
