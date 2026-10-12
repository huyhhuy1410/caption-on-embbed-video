import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { WebSocket } from 'ws';
import { CaptureScope, isScope, sameScope } from '../streaming-transcript';

const SIDECAR_URL = 'ws://127.0.0.1:9000/ws';
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 5_000;

@Injectable()
export class SidecarService implements OnModuleInit, OnModuleDestroy {
  private socket?: WebSocket;
  private onMessage?: (data: string) => void;
  private onOpen?: () => void;
  private disposed = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  /**
   * Control state must not be lost during disconnect: old audio is useless (drop),
   * but reset and source-switch are one-shot — keep only the latest.
   */
  private pendingReset = false;
  private pendingSourceId?: string;
  private latestScope?: CaptureScope;
  private language: string | null = null;
  private playback?: 'paused' | 'ended' | 'playing';

  sendControl(
    control: CaptureScope & {
      type: string;
      language?: string | null;
      state?: 'paused' | 'ended' | 'playing';
      seekTimeAtCapture?: number;
    },
  ): boolean {
    if (!isScope(control)) return false;
    const old = this.latestScope;
    if (
      old?.sessionId === control.sessionId &&
      (control.generation < old.generation ||
        (control.generation === old.generation &&
          control.sourceId !== old.sourceId))
    )
      return false;
    if (old && !sameScope(old, control)) this.playback = undefined;
    this.latestScope = {
      sessionId: control.sessionId,
      generation: control.generation,
      sourceId: control.sourceId,
    };
    if (control.type === 'source-language')
      this.language = control.language ?? null;
    if (control.type === 'playback') this.playback = control.state;
    return this.sendMetadata(
      control.type === 'seek' ? { ...control, type: 'reset' } : control,
    );
  }

  private restoreScope(): void {
    if (!this.latestScope) return;
    this.sendMetadata({ ...this.latestScope, type: 'source-switch' });
    this.sendMetadata({
      ...this.latestScope,
      type: 'source-language',
      language: this.language,
    });
    this.sendMetadata({ ...this.latestScope, type: 'reset' });
    if (this.playback)
      this.sendMetadata({
        ...this.latestScope,
        type: 'playback',
        state: this.playback,
      });
  }

  onModuleInit(): void {
    this.connect();
  }

  private connect(): void {
    if (this.disposed) return;
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const socket = new WebSocket(SIDECAR_URL);
    this.socket = socket;

    socket.on('open', () => {
      // Old socket may open late after a new one replaced it
      if (socket !== this.socket || this.disposed) {
        socket.close();
        return;
      }
      this.reconnectAttempt = 0;
      console.info('Connected to Whisper sidecar');

      // Callback runs before flush so current source overrides pending old source
      this.onOpen?.();
      if (this.latestScope) this.restoreScope();
      else this.flushPendingControls();
    });

    socket.on('message', (data) => {
      if (socket !== this.socket || this.disposed) return;
      const message = data.toString();
      console.info('Message from sidecar:', message);
      this.onMessage?.(message);
    });

    socket.on('error', (error) => {
      // `ws` always emits close after error. Don't schedule here — one error would create two reconnect timers.
      console.error('Sidecar error:', error.message);
    });

    socket.on('close', () => {
      if (socket !== this.socket) return;
      this.socket = undefined;
      if (this.disposed) return;
      console.info('Disconnected from sidecar');
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== undefined) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempt += 1;
    console.info(`Reconnecting to Whisper sidecar in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private sendNow(payload: Buffer | string): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(payload);
      return true;
    } catch (error: unknown) {
      console.warn(
        'Could not send to sidecar:',
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }

  /** Realtime audio not queued: old audio is stale on reconnect. */
  sendAudio(audio: Buffer): boolean {
    return this.sendNow(audio);
  }

  /** Per-chunk metadata drops with that chunk's audio. */
  sendMetadata(metadata: unknown): boolean {
    return this.sendNow(JSON.stringify(metadata));
  }

  sendReset(): void {
    if (this.sendMetadata({ type: 'reset' })) {
      this.pendingReset = false;
    } else {
      this.pendingReset = true;
    }
  }

  sendSourceSwitch(sourceId: string): void {
    if (this.sendMetadata({ type: 'source-switch', sourceId })) {
      // Successful send clears pending old source; keeping it would flush old source AFTER new, reversing namespace.
      this.pendingSourceId = undefined;
    } else {
      // Only latest source matters
      this.pendingSourceId = sourceId;
    }
  }

  private flushPendingControls(): void {
    // Source first, then reset: namespace/buffer must be established before resetting seek state within that source.
    if (this.pendingSourceId !== undefined) {
      const sourceId = this.pendingSourceId;
      if (this.sendMetadata({ type: 'source-switch', sourceId })) {
        this.pendingSourceId = undefined;
      }
    }
    if (this.pendingReset && this.sendMetadata({ type: 'reset' })) {
      this.pendingReset = false;
    }
  }

  setMessageHandler(handler: (data: string) => void): void {
    this.onMessage = handler;
  }

  /** Called on every open, including first connection — gateway guards null source. */
  setOpenHandler(handler: () => void): void {
    this.onOpen = handler;
  }

  onModuleDestroy(): void {
    this.disposed = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }
}
