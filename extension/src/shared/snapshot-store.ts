import type { CaptionWord, SentenceTranslation, TranscriptSnapshot } from './protocol';

export interface SnapshotStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export type SnapshotStoreOptions = {
  ttlMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  maxSnapshotBytes?: number;
  now?: () => number;
};

type Entry = { key: string; lastAccess: number; snapshot: TranscriptSnapshot };
const STORAGE_KEY = 'caption-ai.transcript-snapshots.v1';
const MAX_WORDS = 50_000;
const MAX_TRANSLATIONS = 10_000;
const MAX_TIME = 365 * 24 * 60 * 60;
const encoder = new TextEncoder();
// Cả load (LRU touch) và save đều read-modify-write; tuần tự cả các instance trong SW.
let writes: Promise<unknown> = Promise.resolve();

export function durableVideoKey(url: string): string | null {
  if (typeof url !== 'string' || url.length > 8192) return null;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    for (const key of parsed.searchParams.keys()) {
      // URL ký/expiring chỉ có identity phiên; không giữ credential trong storage.
      if (/^(?:token|access[_-]?token|auth(?:orization)?|jwt|key|api[_-]?key|secret|password|signature|sig|expires?|expiry|exp|policy|credential|session(?:id)?|nonce|timestamp|ts|live)$/i.test(key) ||
        /^(?:x-amz-|x-goog-|hdnts|hdnea)/i.test(key)) return null;
    }
    parsed.hash = '';
    return parsed.href;
  } catch {
    return null;
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: unknown, max = MAX_TIME): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
}

function text(value: unknown, max: number, empty = false): value is string {
  return typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0);
}

function identity(value: Record<string, unknown>): boolean {
  return (value.sourceId === undefined || value.sourceId === null || text(value.sourceId, 512)) &&
    (value.wordId === undefined || text(value.wordId, 512)) &&
    (value.captionId === undefined || text(value.captionId, 512)) &&
    (value.windowedGroupId === undefined || text(value.windowedGroupId, 512));
}

function captionKey(value: CaptionWord | SentenceTranslation): string {
  return JSON.stringify([value.sourceId ?? null, value.captionId ? ['id', value.captionId] : value.windowedGroupId ? ['windowed', value.windowedGroupId] : ['time', value.captionStart]]);
}

function normalizeSnapshot(raw: unknown, now: number): TranscriptSnapshot | null {
  if (!object(raw) || raw.version !== 1 || !finite(raw.savedAt, now) ||
    !Array.isArray(raw.words) || raw.words.length > MAX_WORDS ||
    !Array.isArray(raw.translations) || raw.translations.length > MAX_TRANSLATIONS) return null;
  const words: CaptionWord[] = [];
  const excluded = new Set<string>();
  for (const value of raw.words) {
    if (!object(value) || !text(value.w, 4096) || !finite(value.s) || !finite(value.e) || value.e < value.s ||
      !finite(value.videoStart) || !finite(value.videoEnd) || value.videoEnd < value.videoStart ||
      !finite(value.captionStart) || !finite(value.c, 1) || !identity(value) ||
      (value.provisional !== undefined && typeof value.provisional !== 'boolean') ||
      (value.capturedAtEpochMs !== undefined && !finite(value.capturedAtEpochMs, Number.MAX_SAFE_INTEGER))) return null;
    // Chỉ copy whitelist, không persist audio, API key hay field ngoài contract.
    const word: CaptionWord = {
      w: value.w, s: value.s, e: value.e, videoStart: value.videoStart,
      videoEnd: value.videoEnd, captionStart: value.captionStart, c: value.c,
    };
    if (value.sourceId !== undefined) word.sourceId = value.sourceId as string | null;
    if (value.windowedGroupId !== undefined) word.windowedGroupId = value.windowedGroupId as string;
    if (value.wordId !== undefined) word.wordId = value.wordId as string;
    if (value.captionId !== undefined) word.captionId = value.captionId as string;
    if (value.provisional !== undefined) word.provisional = value.provisional;
    if (value.capturedAtEpochMs !== undefined) word.capturedAtEpochMs = value.capturedAtEpochMs as number;
    if (word.provisional === true || ((word.wordId !== undefined || word.captionId !== undefined) && word.provisional !== false)) {
      excluded.add(captionKey(word));
    }
    words.push(word);
  }
  const finalized = words.filter((word) => !excluded.has(captionKey(word)));
  const captions = new Set(finalized.map(captionKey));
  const translations: SentenceTranslation[] = [];
  for (const value of raw.translations) {
    if (!object(value) || !finite(value.captionStart) || !identity(value) ||
      !text(value.text, 16_384, true) || !text(value.vi, 16_384, true)) return null;
    const translation: SentenceTranslation = { captionStart: value.captionStart, text: value.text, vi: value.vi };
    if (value.sourceId !== undefined) translation.sourceId = value.sourceId as string | null;
    if (value.captionId !== undefined) translation.captionId = value.captionId as string;
    if (value.windowedGroupId !== undefined) translation.windowedGroupId = value.windowedGroupId as string;
    if (captions.has(captionKey(translation)) && (!translation.windowedGroupId ||
      finalized.filter(word => captionKey(word) === captionKey(translation)).map(word => word.w).join(' ') === translation.text)) translations.push(translation);
  }
  return { version: 1, savedAt: raw.savedAt, words: finalized, translations };
}

function bytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

function positive(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('Snapshot limits must be positive integers');
  return value;
}

export class SnapshotStore {
  private readonly storage: SnapshotStorage;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxSnapshotBytes: number;
  private readonly now: () => number;

  constructor(storage?: SnapshotStorage, options: SnapshotStoreOptions = {}) {
    // Chỉ khởi tạo bản mặc định trong service worker; content script gửi messaging.
    this.storage = storage ?? chrome.storage.local;
    this.ttlMs = positive(options.ttlMs, 7 * 24 * 60 * 60 * 1000);
    this.maxEntries = positive(options.maxEntries, 20);
    this.maxBytes = positive(options.maxBytes, 4 * 1024 * 1024);
    this.maxSnapshotBytes = positive(options.maxSnapshotBytes, 2 * 1024 * 1024);
    this.now = options.now ?? Date.now;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = writes.then(operation);
    writes = result.catch(() => undefined);
    return result;
  }

  private async readEntries(now: number): Promise<Entry[]> {
    const result = await this.storage.get(STORAGE_KEY);
    const raw = result[STORAGE_KEY];
    if (!object(raw) || raw.version !== 1 || !Array.isArray(raw.entries)) return [];
    // Chống array khổng lồ từ storage bị sửa, không duyệt dữ liệu vô hạn.
    if (raw.entries.length > 1000) return [];
    const byKey = new Map<string, Entry>();
    for (const value of raw.entries) {
      if (!object(value) || typeof value.key !== 'string' || durableVideoKey(value.key) !== value.key ||
        !finite(value.lastAccess, now)) continue;
      const snapshot = normalizeSnapshot(value.snapshot, now);
      if (!snapshot || now - snapshot.savedAt >= this.ttlMs || bytes(snapshot) > this.maxSnapshotBytes) continue;
      const previous = byKey.get(value.key);
      if (!previous || previous.lastAccess < value.lastAccess) byKey.set(value.key, { key: value.key, lastAccess: value.lastAccess, snapshot });
    }
    return this.bound([...byKey.values()]);
  }

  private bound(entries: Entry[]): Entry[] {
    entries.sort((a, b) => b.lastAccess - a.lastAccess || b.snapshot.savedAt - a.snapshot.savedAt);
    entries = entries.slice(0, this.maxEntries);
    while (entries.length && bytes({ version: 1, entries }) + encoder.encode(STORAGE_KEY).length > this.maxBytes) entries.pop();
    return entries;
  }

  private async writeEntries(entries: Entry[]): Promise<void> {
    await this.storage.set({ [STORAGE_KEY]: { version: 1, entries: this.bound(entries) } });
  }

  async load(url: string): Promise<TranscriptSnapshot | null> {
    const key = durableVideoKey(url);
    if (!key) return null;
    return this.enqueue(async () => {
      const now = this.now();
      const entries = await this.readEntries(now);
      const entry = entries.find((item) => item.key === key);
      if (entry) entry.lastAccess = now;
      await this.writeEntries(entries);
      return entry?.snapshot ?? null;
    });
  }

  async save(url: string, snapshot: TranscriptSnapshot): Promise<void> {
    const key = durableVideoKey(url);
    if (!key) return;
    // Copy ngay khi gọi: caller có thể sửa history khi operation đang đợi queue.
    const normalized = normalizeSnapshot(snapshot, this.now());
    if (!normalized) throw new TypeError('Invalid transcript snapshot');
    if (bytes(normalized) > this.maxSnapshotBytes) throw new RangeError('Transcript snapshot exceeds byte cap');
    return this.enqueue(async () => {
      const now = this.now();
      normalized.savedAt = now;
      const entries = (await this.readEntries(now)).filter((entry) => entry.key !== key);
      if (normalized.words.length) entries.unshift({ key, lastAccess: now, snapshot: normalized });
      await this.writeEntries(entries);
    });
  }
}
