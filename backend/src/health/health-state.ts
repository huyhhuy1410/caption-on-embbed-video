// Must match HealthState in extension/src/shared/protocol.ts; don't import extension source into backend build.
export type HealthState = {
  backend: 'ready' | 'unavailable';
  sidecar: 'ready' | 'loading' | 'error' | 'unavailable';
  model?: string;
  mode?: 'windowed' | 'streaming';
  message?: string;
};
