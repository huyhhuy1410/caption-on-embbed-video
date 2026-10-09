import { Injectable } from '@nestjs/common';

import type { HealthState } from './health-state';
export type { HealthState } from './health-state';

export const SIDECAR_HEALTH_URL = 'http://127.0.0.1:9000/health';
export const SIDECAR_HEALTH_TIMEOUT_MS = 1500;

@Injectable()
export class HealthService {
  async check(): Promise<HealthState> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      SIDECAR_HEALTH_TIMEOUT_MS,
    );
    try {
      const response = await fetch(SIDECAR_HEALTH_URL, {
        signal: controller.signal,
        redirect: 'error',
      });
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (controller.signal.aborted) throw new Error('timeout');
        return this.invalidResponse();
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return this.invalidResponse();
      }
      const data = payload as Record<string, unknown>;
      const status = data.status === 'ok' ? 'ready' : data.status;
      // Model loading/error có thể trả HTTP 503 nhưng không phải sidecar bị tắt.
      if (status !== 'ready' && status !== 'loading' && status !== 'error') {
        return response.ok
          ? this.invalidResponse()
          : {
              backend: 'ready',
              sidecar: 'unavailable',
              message: 'Sidecar health endpoint is unavailable.',
            };
      }
      if (!response.ok && status === 'ready') {
        return {
          backend: 'ready',
          sidecar: 'unavailable',
          message: 'Sidecar health endpoint is unavailable.',
        };
      }
      const health: HealthState = { backend: 'ready', sidecar: status };
      if (typeof data.model === 'string')
        health.model = data.model.slice(0, 100);
      if (data.mode === 'windowed' || data.mode === 'streaming')
        health.mode = data.mode;
      if (typeof data.message === 'string')
        health.message = data.message.slice(0, 500);
      return health;
    } catch {
      return {
        backend: 'ready',
        sidecar: 'unavailable',
        message: controller.signal.aborted
          ? 'Sidecar health check timed out.'
          : 'Sidecar health endpoint is unreachable or returned invalid JSON.',
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private invalidResponse(): HealthState {
    return {
      backend: 'ready',
      sidecar: 'error',
      message: 'Sidecar returned an invalid health response.',
    };
  }
}
