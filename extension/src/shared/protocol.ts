export type CaptureScope = {
  sessionId: string;
  generation: number;
  sourceId: string | null;
};

export type CaptionWord = {
  w: string;
  s: number;
  e: number;
  videoStart: number;
  videoEnd: number;
  captionStart: number;
  c: number;
  sourceId?: string | null;
  wordId?: string;
  captionId?: string;
  windowedGroupId?: string;
  provisional?: boolean;
  capturedAtEpochMs?: number;
};

export type CaptionState = {
  captionId: string;
  captionStart: number;
  wordIds: string[];
  finalized: boolean;
};

export type WordsUpdate = CaptureScope & {
  type: 'words';
  mode: 'streaming';
  revision: number;
  words: CaptionWord[];
  removedWordIds: string[];
  captions: CaptionState[];
  removedCaptionIds: string[];
  language?: string;
  languageProbability?: number;
  voiced?: boolean;
};

export type SentenceTranslation = {
  captionStart: number;
  captionId?: string;
  windowedGroupId?: string;
  text: string;
  vi: string;
  sourceId?: string | null;
};

export type HealthState = {
  backend: 'ready' | 'unavailable';
  sidecar: 'ready' | 'loading' | 'error' | 'unavailable';
  model?: string;
  mode?: 'windowed' | 'streaming';
  message?: string;
};

export type TranscriptSnapshot = {
  version: 1;
  savedAt: number;
  words: CaptionWord[];
  translations: SentenceTranslation[];
};
