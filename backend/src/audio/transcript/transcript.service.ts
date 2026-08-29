import { Injectable } from '@nestjs/common';
type Word = {
  w: string;
  s: number;
  e: number;
  videoStart: number;
  videoEnd: number;
  c: number;
};
@Injectable()
export class TranscriptService {
  //1. Cấu trúc cache (tương tự python): map<windowAnchorVideoTime, list<Word>>
  private readonly cache = new Map<number, Word[]>();
  addWords(words: Word[]) {
    if (words.length === 0) return;
    const key = Math.floor(words[0].videoStart);
    const existing = this.cache.get(key) ?? [];
    this.cache.set(key, existing.concat(words));
    console.info(
      'Cache words:',
      words.length,
      'video range:',
      words[0].videoStart,
      words[words.length - 1].videoStart,
      'key:',
      key,
    );
  }
  getRange(fromSec: number, toSec: number) {
    let result: Word[] = [];
    for (const [anchorTime, words] of this.cache.entries()) {
      const lastWord = words[words.length - 1];
      const bucketEnd = lastWord?.videoEnd ?? anchorTime;
      if (anchorTime <= toSec && bucketEnd >= fromSec) {
        result = result.concat(words);
      }
    }
    result.sort((a, b) => a.videoStart - b.videoStart);
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
    return depuped.filter(
      (word) => word.videoStart >= fromSec && word.videoStart <= toSec,
    );
  }
}
