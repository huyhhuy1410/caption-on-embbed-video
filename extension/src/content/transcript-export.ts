import type { CaptionWord, SentenceTranslation } from '../shared/protocol';

type Cue = { start: number; end: number; en: string; vi: string };

function captionKey(value: CaptionWord | SentenceTranslation): string {
  return JSON.stringify([
    value.sourceId ?? null,
    value.captionId ? ['id', value.captionId] : value.windowedGroupId ? ['windowed', value.windowedGroupId] : ['time', value.captionStart],
  ]);
}

function validWord(word: CaptionWord): boolean {
  return typeof word.w === 'string' && word.w.trim().length > 0 &&
    Number.isFinite(word.videoStart) && word.videoStart >= 0 &&
    Number.isFinite(word.videoEnd) && word.videoEnd > word.videoStart &&
    word.videoEnd <= Number.MAX_SAFE_INTEGER / 1000 &&
    Number.isFinite(word.captionStart) && word.captionStart >= 0;
}

function plainText(text: string): string {
  return text.replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').trim();
}

function timestamp(seconds: number, separator: ',' | '.'): string {
  const ms = Math.round(seconds * 1000);
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor(ms / 60_000) % 60;
  const secs = Math.floor(ms / 1000) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}${separator}${String(ms % 1000).padStart(3, '0')}`;
}

function cueText(text: string): string {
  // Prevent ASR text from creating markup or faking timing lines in subtitle.
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/--&gt;/g, '—&gt;');
}

export function serializeTranscript(
  format: 'srt' | 'vtt' | 'txt',
  words: CaptionWord[],
  translations: SentenceTranslation[],
): string {
  if (!['srt', 'vtt', 'txt'].includes(format)) throw new TypeError('Unsupported transcript format');
  const groups = new Map<string, CaptionWord[]>();
  for (const word of words) {
    const key = captionKey(word);
    const group = groups.get(key) ?? [];
    group.push(word);
    groups.set(key, group);
  }
  const viByKey = new Map<string, string>();
  for (const translation of translations) {
    if (typeof translation.vi === 'string') viByKey.set(captionKey(translation), plainText(translation.vi));
  }
  const cues: Cue[] = [];
  for (const [key, group] of groups) {
    // Legacy windowed has no provisional; streaming must confirm entire sentence.
    if (group.some((word) => word.provisional === true ||
      ((word.wordId !== undefined || word.captionId !== undefined) && word.provisional !== false) ||
      !validWord(word))) continue;
    const byId = new Map<string, CaptionWord>();
    const legacy: CaptionWord[] = [];
    for (const word of group) {
      if (word.wordId) byId.set(word.wordId, word);
      else legacy.push(word);
    }
    const ordered = [...legacy, ...byId.values()].sort((a, b) => a.videoStart - b.videoStart || a.videoEnd - b.videoEnd);
    if (!ordered.length) continue;
    const start = ordered[0].videoStart;
    const end = ordered.reduce((latest, word) => Math.max(latest, word.videoEnd), start + 0.001);
    const en = plainText(ordered.map((word) => word.w.trim()).join(' '))
      .replace(/\s+([,.;:!?])/g, '$1');
    cues.push({ start, end, en, vi: viByKey.get(key) ?? '' });
  }
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  if (format === 'txt') {
    return cues.map((cue) => [cue.en, cue.vi].filter(Boolean).join('\n')).join('\n\n') + (cues.length ? '\n' : '');
  }
  const separator = format === 'srt' ? ',' : '.';
  const body = cues.map((cue, index) => [
    String(index + 1),
    `${timestamp(cue.start, separator)} --> ${timestamp(Math.max(cue.end, (Math.round(cue.start * 1000) + 1) / 1000), separator)}`,
    cueText(cue.en),
    ...(cue.vi ? [cueText(cue.vi)] : []),
  ].join('\n')).join('\n\n');
  return (format === 'vtt' ? 'WEBVTT\n\n' : '') + body + (body ? '\n' : '');
}
