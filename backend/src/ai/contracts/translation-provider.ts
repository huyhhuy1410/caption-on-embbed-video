import { Translation } from '../types/translation';

export interface TranslationProvider {
  readonly name: string;
  translate(sentence: string, to: string, from: string): Promise<Translation>;

  /**
   * Dịch nhiều câu trong MỘT request — mảng trả về song song với mảng vào
   * (`texts[i]` là bản dịch của `sentences[i]`).
   *
   * Vì sao cần: dịch từng câu riêng tốn 1 request/câu, mà Gemini free tier chỉ
   * cho ~15 request/phút trong khi hệ thống sinh ~15–25 nhóm caption mỗi phút ⇒
   * vượt trần ngay trong điều kiện bình thường. Design §4.3 đã ghi
   * "batched on finalize" — đây là phần đó.
   */
  translateBatch(
    sentences: string[],
    to: string,
    from: string,
  ): Promise<Translation[]>;
}
