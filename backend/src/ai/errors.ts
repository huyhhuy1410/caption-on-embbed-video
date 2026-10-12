/**
 * Provider temporarily unavailable. The `retryable` flag determines retry behavior:
 * - `false` (429 quota): project-wide state, pause all requests and preserve queue
 * - `true` (503 overload): request-specific, retry with backoff but count attempts
 */
export class ProviderUnavailableError extends Error {
  /** Server-specified wait time (from `retryDelay`), uncapped. */
  readonly retryAfterMs: number;

  /**
   * Default false = treat as project-wide quota exhaustion (pause all, preserve queue).
   * Only batch-specific transient errors (503) pass true.
   */
  readonly retryable: boolean;

  constructor(message: string, retryAfterMs: number, retryable = false) {
    super(message);
    this.name = 'ProviderUnavailableError';
    this.retryAfterMs = retryAfterMs;
    this.retryable = retryable;
  }
}
