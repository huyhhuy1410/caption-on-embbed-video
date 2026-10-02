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

/** Khoảng video-time hai bản của cùng một từ được coi là trùng (giây). */
const DEDUP_WINDOW_SEC = 0.5;

/**
 * Bỏ bản ghi trùng của cùng một từ — sliding window ghi lại 1.5s audio hai lần,
 * nên cùng một từ xuất hiện ở hai mốc lệch nhau ít.
 *
 * ⚠️ Chỉ so với từ LIỀN KỀ sau khi sort: các bản trùng nằm cạnh nhau, và mỗi
 * từ chỉ cần so với bản đã giữ gần nhất. So với toàn bộ danh sách là O(n²) —
 * `getRangeFrom` có thể trả hàng nghìn từ.
 */
function dedupWords(sorted: Word[]): Word[] {
  const out: Word[] = [];
  for (const word of sorted) {
    const last = out[out.length - 1];
    if (
      last &&
      last.w.toLowerCase() === word.w.toLowerCase() &&
      Math.abs(last.videoStart - word.videoStart) < DEDUP_WINDOW_SEC
    ) {
      continue;
    }
    out.push(word);
  }
  return out;
}

function normalizeSource(sourceId: string | null | undefined): string | null {
  // `undefined` và `null` là CÙNG một namespace (không rõ nguồn). Không gộp thì
  // Word có `sourceId: undefined` (test cũ, sidecar cũ) không bao giờ khớp với
  // truy vấn `null` — mà gateway luôn truyền `null` khi chưa biết nguồn.
  return sourceId ?? null;
}

/**
 * Khoá cache = (nguồn, giây). `videoStart` là mốc RIÊNG của từng video nên không
 * dùng làm khoá đơn thuần: hai video cùng tua tới 0:30 sẽ đè lên nhau và replay
 * trả lời của video trước. Nguồn rỗng gói thành chuỗi riêng, không gộp — xem
 * `Word.sourceId`.
 */
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

  private readonly cache = new Map<string, Bucket>();

  // Tách map riêng khỏi `cache`: words đến liên tục, bản dịch đến muộn (sau call AI).
  private readonly translations = new Map<string, TranslationBucket>();
  addWords(words: Word[]) {
    if (words.length === 0) return;

    // Khoảng video-time mà lượt ghi này phủ, dùng để tìm bản CŨ cần thay.
    const from = Math.min(...words.map((w) => w.videoStart));
    const to = Math.max(...words.map((w) => w.videoEnd));

    // ⚠️ Xoá bản CŨ của CÙNG vùng này trước khi ghi (Issue 5.25).
    //
    // Sau mỗi lần tua, sidecar xoá bộ đệm và whisper gõ lại đúng vùng audio đó,
    // nhưng timestamp ra KHÁC: đường tính anchor đổi (`resolveAnchor` lấy mẫu
    // của chunk trước, `compute_video_time` trừ 1.5s gối đầu) nên cùng một câu
    // ra hai mốc lệch nhau hơn 0.5s. Dedup lúc đọc chỉ so với từ LIỀN KỀ nên
    // không nhận ra là trùng ⇒ giữ cả hai ⇒ bucket phình, `getRange` trả lẫn
    // các bản timeline khác nhau, overlay nhảy giữa chúng.
    //
    // Duyệt MỌI bucket của nguồn này chứ không chỉ bucket trùng khoá: sau khi
    // tua, anchor lệch làm cùng một vùng rơi vào hai khoá khác nhau (`v1|50` và
    // `v1|51`), nên chỉ xoá bucket trùng khoá sẽ bỏ sót bản cũ.
    const source = normalizeSource(words[0].sourceId);
    for (const [bucketKey, bucket] of this.cache) {
      if (normalizeSource(bucket.words[0]?.sourceId) !== source) continue;
      // Giữ từ nằm NGOÀI hoàn toàn vùng mới.
      //
      // ⚠️ So sánh `videoStart` với `videoEnd` khi quyết định "nằm ngoài" — nếu
      // so cả hai với `from` thì từ cũ chạm biên vẫn bị xoá, và thay vào đó
      // vùng mới ghi đè một từ lệch vài trăm ms cũng bị xoá ⇒ cache lủng củng.
      // Một từ chỉ bị coi là thuộc vùng mới khi nó CHỒNG lấn lên đó; từ nằm
      // ngay trước/sau thì giữ nguyên, vì nó phục vụ một đoạn khác.
      const kept = bucket.words.filter(
        (w) => w.videoStart >= to || w.videoEnd <= from,
      );
      if (kept.length === bucket.words.length) continue;
      if (kept.length === 0) {
        this.cache.delete(bucketKey);
      } else {
        bucket.words = kept;
      }
    }

    const key = bucketKey(words[0].sourceId, Math.floor(words[0].videoStart));
    const existing = this.cache.get(key);
    const merged = existing
      ? existing.words.concat(words).sort((a, b) => a.videoStart - b.videoStart)
      : words;
    this.cache.set(key, {
      words: merged,
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
  /**
   * Từ trong `[fromSec, toSec]` của ĐÚNG nguồn này.
   *
   * `sourceId` bắt buộc: không lọc theo nguồn thì hai video cùng nằm trong một
   * khoảng giây sẽ trả lẫn lời của nhau.
   */
  getRange(sourceId: string | null | undefined, fromSec: number, toSec: number) {
    let result: Word[] = [];
    const now = Date.now();
    for (const [key, bucket] of this.cache) {
      if (now - bucket.lastAccess > TranscriptService.TTL_MS) {
        this.cache.delete(key);
      }
    }
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

    result.sort((a, b) => a.videoStart - b.videoStart);
    return dedupWords(result).filter(
      (word) => word.videoStart >= fromSec && word.videoStart <= toSec,
    );
  }

  /**
   * Từ đã xem từ `fromSec` trở đi — dùng cho replay sau khi tua.
   *
   * Cố ý không chặn trên: trần TTL/LRU đã giới hạn tổng số bucket, còn giới hạn
   * cửa sổ thì sau mốc đó hệ thống không biết đã xem tới đâu và rơi về nhịp
   * transcribe thường (~2s), tức replay được một đoạn rồi đoạn sau phải chờ.
   *
   * ⚠️ Điều kiện `bucket.anchorTime < fromSec` bỏ qua CẢ bucket, nên bucket trải
   * qua mốc tua sẽ mất phần sau mốc — xem issue đã ghi cho giới hạn này.
   */
  getRangeFrom(
    sourceId: string | null | undefined,
    fromSec: number,
  ): Word[] {
    const now = Date.now();

    for (const [key, bucket] of this.cache) {
      if (now - bucket.lastAccess > TranscriptService.TTL_MS) {
        this.cache.delete(key);
      }
    }

    const source = normalizeSource(sourceId);
    const result: Word[] = [];
    for (const bucket of this.cache.values()) {
      if (normalizeSource(bucket.words[0]?.sourceId) !== source) continue;
      // Bucket bắt đầu SAU mốc tua thì không liên quan.
      if (bucket.anchorTime < fromSec) continue;
      bucket.lastAccess = now;
      result.push(...bucket.words);
    }

    result.sort((a, b) => a.videoStart - b.videoStart);
    const deduped = dedupWords(result);
    return deduped.filter((word) => word.videoStart >= fromSec);
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

  /** Bản dịch của các nhóm trong `[fromSec, toSec]`, sort theo mốc video. */
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

  /** Bản dịch của mọi nhóm đã xem từ `fromSec` trở đi — đi kèm `getRangeFrom`. */
  getTranslationsFrom(
    sourceId: string | null | undefined,
    fromSec: number,
  ): SentenceTranslation[] {
    const now = Date.now();
    const result: SentenceTranslation[] = [];
    const source = normalizeSource(sourceId);

    for (const [key, bucket] of this.translations) {
      if (now - bucket.lastAccess > TranscriptService.TTL_MS) {
        this.translations.delete(key);
        continue;
      }
      if (normalizeSource(bucket.t.sourceId) !== source) continue;
      if (bucket.t.captionStart < fromSec) continue;
      bucket.lastAccess = now;
      result.push(bucket.t);
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
