import { Injectable } from '@nestjs/common';
export type Word = {
  w: string;
  s: number;
  e: number;
  videoStart: number;
  videoEnd: number;
  captionStart: number;
  c: number;
};

type Bucket = {
  words: Word[];
  lastAccess: number;
};

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
};

type TranslationBucket = {
  t: SentenceTranslation;
  lastAccess: number;
};

@Injectable()
export class TranscriptService {
  private static readonly TTL_MS = 30 * 60 * 1000;
  private static readonly MAX_BUCKETS = 300;

  //1. Cấu trúc cache (tương tự python): map<windowAnchorVideoTime, list<Word>>
  private readonly cache = new Map<number, Bucket>();

  //1b. Cache bản dịch, keyed theo captionStart. Tách map riêng vì vòng đời
  // khác words: words đến liên tục, bản dịch đến muộn (sau call AI).
  private readonly translations = new Map<number, TranslationBucket>();
  addWords(words: Word[]) {
    if (words.length === 0) return;
    const key = Math.floor(words[0].videoStart);
    const existing = this.cache.get(key);
    this.cache.set(key, {
      words: existing ? existing.words.concat(words) : words,
      lastAccess: Date.now(),
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
  // 2. Truy xuất danh sách từ trong khoảng thời gian [fromSec, toSec] (phục vụ tính năng Seek Replay)
  getRange(fromSec: number, toSec: number) {
    let result: Word[] = [];
    const now = Date.now();
    for (const [key, bucket] of this.cache) {
      if (now - bucket.lastAccess > TranscriptService.TTL_MS) {
        this.cache.delete(key);
      }
    }
    // 2.1. Lấy tất cả các bucket có khoảng thời gian giao thoa với [fromSec, toSec]
    for (const [anchorTime, bucket] of this.cache) {
      const lastWord = bucket.words[bucket.words.length - 1];
      const bucketEnd = lastWord?.videoEnd ?? anchorTime;
      if (anchorTime <= toSec && bucketEnd >= fromSec) {
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
      let oldestKey: number | undefined;
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

  /** Bản dịch đã cache cho nhóm này, nếu có. */
  getTranslation(captionStart: number): SentenceTranslation | undefined {
    return this.translations.get(captionStart)?.t;
  }

  setTranslation(t: SentenceTranslation): void {
    this.translations.set(t.captionStart, { t, lastAccess: Date.now() });
    this.evictTranslations();
  }

  /**
   * Bản dịch của các nhóm nằm trong `[fromSec, toSec]`, sort theo mốc video.
   * Dùng cho replay: seek về đoạn đã xem thì VI hiện ngay, không gọi AI
   * (FR-7.2, FR-7.5).
   */
  getTranslations(fromSec: number, toSec: number): SentenceTranslation[] {
    const now = Date.now();
    const result: SentenceTranslation[] = [];

    for (const [key, bucket] of this.translations) {
      if (now - bucket.lastAccess > TranscriptService.TTL_MS) {
        this.translations.delete(key);
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
      let oldestKey: number | undefined;
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
