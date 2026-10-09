import type { CaptionState, CaptionWord, CaptureScope, WordsUpdate } from './protocol';

export function sameScope(a: CaptureScope, b: CaptureScope): boolean {
  return a.sessionId === b.sessionId && a.generation === b.generation && a.sourceId === b.sourceId;
}

export function captionKey(word: { captionId?: string; windowedGroupId?: string; captionStart: number }): string {
  return word.captionId ?? (word.windowedGroupId ? `windowed-id:${word.windowedGroupId}` : `windowed:${word.captionStart}`);
}

export function validWord(value: unknown): value is CaptionWord {
  if (!value || typeof value !== 'object') return false;
  const word = value as CaptionWord;
  return typeof word.w === 'string' && word.w.length > 0 && word.w.length <= 500 &&
    Number.isFinite(word.videoStart) && word.videoStart >= 0 && Number.isFinite(word.videoEnd) &&
    word.videoEnd >= word.videoStart && Number.isFinite(word.captionStart) &&
    Number.isFinite(word.s) && Number.isFinite(word.e) && word.e >= word.s && Number.isFinite(word.c);
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function sameWord(a: CaptionWord, b: CaptionWord): boolean {
  return a.wordId === b.wordId && a.captionId === b.captionId && a.sourceId === b.sourceId &&
    a.w === b.w && a.videoStart === b.videoStart && a.videoEnd === b.videoEnd &&
    a.captionStart === b.captionStart && a.provisional === b.provisional;
}

export class TranscriptState {
  private words = new Map<string, CaptionWord>();
  private captions = new Map<string, CaptionState>();
  private scope: CaptureScope | null = null;
  private revision = 0;

  setScope(scope: CaptureScope): void {
    if (this.scope && sameScope(this.scope, scope)) return;
    if (this.scope?.sourceId !== scope.sourceId || this.scope?.sessionId !== scope.sessionId) {
      this.clear();
    } else {
      for (const [id, word] of this.words) {
        if (!this.captions.get(word.captionId!)?.finalized) this.words.delete(id);
      }
      for (const [id, caption] of this.captions) {
        if (!caption.finalized) this.captions.delete(id);
      }
    }
    this.scope = { ...scope };
    this.revision = 0;
  }

  apply(update: WordsUpdate): boolean {
    if (!this.scope || !sameScope(this.scope, update) || !Number.isSafeInteger(update.revision) ||
        update.revision <= this.revision || !Array.isArray(update.words) ||
        !Array.isArray(update.removedWordIds) || !Array.isArray(update.captions) ||
        !Array.isArray(update.removedCaptionIds) || update.words.length > 10_000 || update.captions.length > 1000) return false;
    if (update.words.some(word => !validWord(word) || !validId(word.wordId) ||
        !validId(word.captionId) || word.sourceId !== update.sourceId || typeof word.provisional !== 'boolean') ||
        update.removedWordIds.some(id => !validId(id)) || update.removedCaptionIds.some(id => !validId(id)) ||
        update.captions.some(caption => !caption || !validId(caption.captionId) ||
          !Array.isArray(caption.wordIds) || !caption.wordIds.length || caption.wordIds.some(id => !validId(id)) ||
          new Set(caption.wordIds).size !== caption.wordIds.length ||
          typeof caption.finalized !== 'boolean' || !Number.isFinite(caption.captionStart))) return false;
    if (new Set(update.words.map(word => word.wordId)).size !== update.words.length ||
        new Set(update.captions.map(caption => caption.captionId)).size !== update.captions.length) return false;

    // Validate cả candidate trước commit; một membership lỗi không được xoá nửa suffix.
    const words = new Map(this.words);
    const captions = new Map(this.captions);
    for (const id of update.removedWordIds) words.delete(id);
    for (const id of update.removedCaptionIds) {
      captions.delete(id);
      for (const [wordId, word] of words) if (word.captionId === id) words.delete(wordId);
    }
    for (const word of update.words) words.set(word.wordId!, { ...word });
    for (const caption of update.captions) {
      captions.set(caption.captionId, { ...caption, wordIds: [...caption.wordIds] });
      const membership = new Set(caption.wordIds);
      for (const [id, word] of words) {
        if (word.captionId === caption.captionId && !membership.has(id)) words.delete(id);
      }
    }
    for (const [id, caption] of captions) {
      for (const wordId of caption.wordIds) {
        const word = words.get(wordId);
        if (!word || word.captionId !== id || word.captionStart !== caption.captionStart ||
            (caption.finalized && word.provisional)) return false;
      }
    }
    for (const [id, word] of words) if (!captions.get(word.captionId!)?.wordIds.includes(id)) return false;
    for (const [id, old] of this.captions) {
      if (!old.finalized) continue;
      const next = captions.get(id);
      if (!next?.finalized || next.captionStart !== old.captionStart ||
          next.wordIds.join('\0') !== old.wordIds.join('\0')) return false;
      for (const wordId of old.wordIds) {
        const nextWord = words.get(wordId);
        if (!nextWord || !sameWord(this.words.get(wordId)!, nextWord)) return false;
      }
    }
    this.words = words;
    this.captions = captions;
    this.revision = update.revision;
    this.prune();
    return true;
  }

  mergeFinalized(incoming: CaptionWord[]): void {
    const groups = new Map<string, CaptionWord[]>();
    for (const word of incoming) {
      if (!validWord(word) || word.provisional !== false || !validId(word.wordId) || !validId(word.captionId)) continue;
      if (this.scope && word.sourceId !== this.scope.sourceId) continue;
      const group = groups.get(word.captionId) ?? [];
      group.push(word);
      groups.set(word.captionId, group);
    }
    for (const [id, group] of groups) {
      if (this.captions.get(id)?.finalized) continue;
      if (new Set(group.map(word => word.wordId)).size !== group.length ||
          group.some(word => word.captionStart !== group[0].captionStart ||
            (this.words.has(word.wordId!) && this.words.get(word.wordId!)!.captionId !== id))) continue;
      for (const [wordId, word] of this.words) if (word.captionId === id) this.words.delete(wordId);
      group.sort((a, b) => a.videoStart - b.videoStart);
      for (const word of group) this.words.set(word.wordId!, { ...word });
      this.captions.set(id, { captionId: id, captionStart: group[0].captionStart,
        wordIds: group.map(word => word.wordId!), finalized: true });
    }
    this.prune();
  }

  values(): CaptionWord[] {
    return [...this.words.values()].sort((a, b) => a.videoStart - b.videoStart || a.videoEnd - b.videoEnd);
  }

  finalized(): CaptionWord[] {
    return this.values().filter(word => this.captions.get(word.captionId!)?.finalized === true);
  }

  clear(): void {
    this.words.clear();
    this.captions.clear();
    this.scope = null;
    this.revision = 0;
  }

  private prune(): void {
    if (this.words.size <= 10_000) return;
    for (const word of this.values()) {
      if (this.words.size <= 10_000) break;
      const id = word.captionId!;
      for (const wordId of this.captions.get(id)?.wordIds ?? []) this.words.delete(wordId);
      this.captions.delete(id);
    }
  }
}
