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
@Injectable()
export class TranscriptService {
  private static readonly TTL_MS = 30 * 60 * 1000;
  private static readonly MAX_BUCKETS = 300;

  //1. Cấu trúc cache (tương tự python): map<windowAnchorVideoTime, list<Word>>
  private readonly cache = new Map<number, Bucket>();
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
}
