import { Injectable } from '@nestjs/common';
import type { WordExplanation } from './types/word-explanation';

export interface ExplainCacheKey {
  word: string;
  context: string;
  lang: string;
  provider: string;
}

export const DEFAULT_EXPLAIN_CACHE_TTL_MS = 30 * 60_000;
export const DEFAULT_EXPLAIN_CACHE_MAX_ENTRIES = 500;
const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024;

interface CacheEntry {
  value: WordExplanation;
  storedAt: number;
  bytes: number;
}

function keyId(key: ExplainCacheKey): string {
  // JSON tuple avoids key collisions (context may contain separators)
  return JSON.stringify([key.provider, key.lang, key.word, key.context]);
}

function readPositiveEnv(name: string, fallback: number): number {
  const parsed = Math.floor(Number(process.env[name]));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

@Injectable()
export class ExplainCacheService {
  private readonly ttlMs = readPositiveEnv(
    'EXPLAIN_CACHE_TTL_MS', DEFAULT_EXPLAIN_CACHE_TTL_MS,
  );
  private readonly maxEntries = readPositiveEnv(
    'EXPLAIN_CACHE_MAX_ENTRIES', DEFAULT_EXPLAIN_CACHE_MAX_ENTRIES,
  );
  private readonly entries = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<WordExplanation>>();
  private bytes = 0;

  lookup(key: ExplainCacheKey, now = Date.now()): WordExplanation | undefined {
    const id = keyId(key);
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (now - entry.storedAt >= this.ttlMs) {
      this.remove(id);
      return undefined;
    }
    this.entries.delete(id);
    this.entries.set(id, entry);
    return entry.value;
  }

  inflight(key: ExplainCacheKey): Promise<WordExplanation> | undefined {
    return this.pending.get(keyId(key));
  }

  track(
    key: ExplainCacheKey,
    run: () => Promise<WordExplanation>,
    now: () => number = Date.now,
  ): Promise<WordExplanation> {
    const id = keyId(key);
    const existing = this.pending.get(id);
    if (existing) return existing;

    // Register promise before running provider (handles sync throws)
    const settled = Promise.resolve().then(run).then(
      value => {
        this.pending.delete(id);
        this.store(id, value, now());
        return value;
      },
      (error: unknown) => {
        this.pending.delete(id);
        throw error;
      },
    );
    this.pending.set(id, settled);
    return settled;
  }

  size(): number {
    return this.entries.size;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  private remove(id: string): void {
    const entry = this.entries.get(id);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(id);
  }

  private store(id: string, value: WordExplanation, now: number): void {
    const bytes = Buffer.byteLength(id) + Buffer.byteLength(JSON.stringify(value));
    // Large response still returned to caller, but not cached
    if (bytes > MAX_ENTRY_BYTES) return;
    this.remove(id);
    this.entries.set(id, { value, storedAt: now, bytes });
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > MAX_CACHE_BYTES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.remove(oldest.value);
    }
  }
}
