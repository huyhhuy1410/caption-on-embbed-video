// Khớp HealthState trong extension/src/shared/protocol.ts; không kéo source extension vào build backend.
export type HealthState = {
  backend: 'ready' | 'unavailable';
  sidecar: 'ready' | 'loading' | 'error' | 'unavailable';
  model?: string;
  mode?: 'windowed' | 'streaming';
  message?: string;
};
