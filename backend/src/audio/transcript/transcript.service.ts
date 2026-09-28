import { Injectable } from '@nestjs/common';
export type Word = {
  w: string;
  s: number;
  e: number;
  videoStart: number;
  videoEnd: number;
  captionStart: number;
  c: number;
  /**
   * Danh tính video tạo ra từ này (Issue 5.20).
   *
   * `videoStart` là mốc thời gian RIÊNG của từng video — video B tua tới 0:30
   * trùng khớp với video A đã xem tới 0:30. Không có field này thì cache của hai
   * video lẫn vào nhau và replay trả về lời của video khác.
   *
   * `null` = không rõ nguồn (sidecar cũ, hoặc metadata thiếu field). Giữ
   * namespace riêng thay vì coi như không nguồn — xem `sourceKey`.
   */
  sourceId?: string | null;
};

type Bucket = {
  words: Word[];
  lastAccess: number;
  /** Giây video đầu tiên của bucket — khoá đã ghép chuỗi nên phải giữ riêng. */
  anchorTime: number;
};

/**
 * Khoá cache = (nguồn, giây) — `videoStart` là mốc RIÊNG của từng video nên
 * không dùng làm khoá đơn thuần: video B tua tới 0:30 sẽ đè lên bucket của
 * video A đã xem tới 0:30, và replay sau đó trả lời của video A (Issue 5.20).
 *
 * Nguồn rỗng đóng gói thành chuỗi riêng, KHÔNG gộp vào một khoá chung — lý do
 * xem `Word.sourceId`.
 */
function normalizeSource(sourceId: string | null | undefined): string | null {
  // `undefined` và `null` là CÙNG một namespace (không rõ nguồn). Không gộp thì
  // Word có `sourceId: undefined` (test cũ, sidecar cũ) không bao giờ khớp với
  // truy vấn `null` — mà gateway luôn truyền `null` khi chưa biết nguồn.
  return sourceId ?? null;
}

function bucketKey(
  sourceId: string | null | undefined,
  videoStart: number,
): string {
  return `${normalizeSource(sourceId) ?? ''}|${videoStart}`;
}

/**
 * Bản dịch của một caption group.
 *
 * Khoá là `captionStart` (mốc video đã round 2 chữ số), KHÔNG phải số thứ tự
 * tăng dần: seek về đoạn cũ phải tra lại đúng bản dịch cũ (FR-7.5), mà số thứ
 * tự thì sinh mới mỗi lần transcribe lại.
 */
export type SentenceTranslation = {
  captionStart: number;
  text: string;
  vi: string;
  /**
   * Danh tính video — cùng lý do như `Word.sourceId`: `captionStart` là mốc
   * riêng của từng video, dùng làm khoá đơn thuần thì bản dịch của video A
   * bị trả cho video B (Issue 5.20).
   */
  sourceId?: string | null;
};

type TranslationBucket = {
  t: SentenceTranslation;
  lastAccess: number;
};

@Injectable()
export class TranscriptService {
  private static readonly TTL_MS = 30 * 60 * 1000;
  private static readonly MAX_BUCKETS = 300;

  //1. Cấu trúc cache: map<nguồn|giây, list<Word>> — xem `bucketKey`.
  private readonly cache = new Map<string, Bucket>();

  //1b. Cache bản dịch, keyed theo captionStart. Tách map riêng vì vòng đời
  // khác words: words đến liên tục, bản dịch đến muộn (sau call AI).
  private readonly translations = new Map<string, TranslationBucket>();
  addWords(words: Word[]) {
    if (words.length === 0) return;
    const key = bucketKey(words[0].sourceId, Math.floor(words[0].videoStart));
    const existing = this.cache.get(key);
    this.cache.set(key, {
      words: existing ? existing.words.concat(words) : words,
      lastAccess: Date.now(),
      anchorTime: Math.floor(words[0].videoStart),
    });
    console.info(
      'Cache words:',
      words.length,
      'video range:',
      words[0].videoStart,
      words[words.length - 1].videoStart,
      'key:',
      key,
    );
    this.evict();
  }
  // 2. Truy xuất danh sách từ trong khoảng [fromSec, toSec] của ĐÚNG nguồn này
  // (phục vụ tính năng Seek Replay — FR-7.2).
  //
  // ⚠️ `sourceId` là tham số BẮT BUỘC về đúng ngữ nghĩa, không phải tuỳ chọn:
  // không lọc theo nguồn thì `getRange` trả lời của mọi video cùng nằm trong
  // khoảng giây đó, tức là tua video B về 0:30 sẽ nhận lời của video A (Issue 5.20).
  getRange(sourceId: string | null | undefined, fromSec: number, toSec: number) {
    let result: Word[] = [];
    const now = Date.now();
    for (const [key, bucket] of this.cache) {
      if (now - bucket.lastAccess > TranscriptService.TTL_MS) {
        this.cache.delete(key);
      }
    }
    // 2.1. Lấy tất cả các bucket có khoảng thời gian giao thoa với [fromSec, toSec]
    for (const bucket of this.cache.values()) {
      if (normalizeSource(bucket.words[0]?.sourceId) !== normalizeSource(sourceId)) {
        continue;
      }
      const lastWord = bucket.words[bucket.words.length - 1];
      const bucketEnd = lastWord?.videoEnd ?? bucket.anchorTime;
      if (bucket.anchorTime <= toSec && bucketEnd >= fromSec) {
        bucket.lastAccess = now;
        result = result.concat(bucket.words);
      }
    }

    // 2.2. Sắp xếp các từ theo thứ tự xuất hiện trên video
    result.sort((a, b) => a.videoStart - b.videoStart);

    // 2.3. Khử trùng lặp (dedup) các từ bị nhận diện lặp giữa các audio window trượt
    const depuped: Word[] = [];
    for (const word of result) {
      const last = depuped[depuped.length - 1];
      if (
        last &&
        last.w.toLowerCase() === word.w.toLowerCase() &&
        Math.abs(last.videoStart - word.videoStart) < 0.5
      ) {
        continue;
      }
      depuped.push(word);
    }

    // 2.4. Lọc chính xác các từ nằm trong khoảng cần tìm
    return depuped.filter(
      (word) => word.videoStart >= fromSec && word.videoStart <= toSec,
    );
  }
  private evict() {
    while (this.cache.size > TranscriptService.MAX_BUCKETS) {
      let oldestKey: string | undefined;
      let oldestAccess = Infinity;

      for (const [key, bucket] of this.cache) {
        if (bucket.lastAccess < oldestAccess) {
          oldestAccess = bucket.lastAccess;
          oldestKey = key;
        }
      }

      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
  }

  // === Bản dịch ===

  /** Bản dịch đã cache cho nhóm này của đúng nguồn, nếu có. */
  getTranslation(
    sourceId: string | null | undefined,
    captionStart: number,
  ): SentenceTranslation | undefined {
    return this.translations.get(bucketKey(sourceId, captionStart))?.t;
  }

  setTranslation(t: SentenceTranslation): void {
    this.translations.set(bucketKey(t.sourceId, t.captionStart), {
      t,
      lastAccess: Date.now(),
    });
    this.evictTranslations();
  }

  /**
   * Bản dịch của các nhóm nằm trong `[fromSec, toSec]`, sort theo mốc video.
   * Dùng cho replay: seek về đoạn đã xem thì VI hiện ngay, không gọi AI
   * (FR-7.2, FR-7.5).
   */
  getTranslations(
    sourceId: string | null | undefined,
    fromSec: number,
    toSec: number,
  ): SentenceTranslation[] {
    const now = Date.now();
    const result: SentenceTranslation[] = [];

    for (const [key, bucket] of this.translations) {
      if (now - bucket.lastAccess > TranscriptService.TTL_MS) {
        this.translations.delete(key);
        continue;
      }
      if (normalizeSource(bucket.t.sourceId) !== normalizeSource(sourceId)) {
        continue;
      }
      if (bucket.t.captionStart >= fromSec && bucket.t.captionStart <= toSec) {
        bucket.lastAccess = now;
        result.push(bucket.t);
      }
    }

    return result.sort((a, b) => a.captionStart - b.captionStart);
  }

  private evictTranslations() {
    while (this.translations.size > TranscriptService.MAX_BUCKETS) {
      let oldestKey: string | undefined;
      let oldestAccess = Infinity;

      for (const [key, bucket] of this.translations) {
        if (bucket.lastAccess < oldestAccess) {
          oldestAccess = bucket.lastAccess;
          oldestKey = key;
        }
      }

      if (oldestKey !== undefined) {
        this.translations.delete(oldestKey);
      }
    }
  }
}
