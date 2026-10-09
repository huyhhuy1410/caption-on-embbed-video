export const LANGUAGE_CONFIDENCE_THRESHOLD = 0.8;
export const LANGUAGE_CONFIRMATION_SAMPLES = 3;

export class LanguageEvidence {
  private candidate: string | null = null;
  private count = 0;

  observe(
    language: string,
    probability: number,
    voiced: boolean,
  ): string | null {
    // Silence không xác nhận hay phủ định ngôn ngữ; chỉ voiced windows mới là bằng chứng.
    if (!voiced) return null;
    if (
      !/^[a-z]{2,3}$/.test(language) ||
      !Number.isFinite(probability) ||
      probability < LANGUAGE_CONFIDENCE_THRESHOLD ||
      probability > 1 ||
      language === "en"
    ) {
      this.reset();
      return null;
    }
    this.count = language === this.candidate ? this.count + 1 : 1;
    this.candidate = language;
    this.count = Math.min(this.count, LANGUAGE_CONFIRMATION_SAMPLES);
    return this.count >= LANGUAGE_CONFIRMATION_SAMPLES ? language : null;
  }

  reset(): void {
    this.candidate = null;
    this.count = 0;
  }
}
