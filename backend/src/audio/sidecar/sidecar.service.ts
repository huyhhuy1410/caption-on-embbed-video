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
   * Control state không được rơi trong lúc mất kết nối: audio cũ là vô dụng nên
   * drop, nhưng reset và đổi nguồn là one-shot nên chỉ giữ bản mới nhất.
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
      // Socket cũ có thể mở muộn sau khi một socket mới đã thay nó.
      if (socket !== this.socket || this.disposed) {
        socket.close();
        return;
      }
      this.reconnectAttempt = 0;
      console.info('Connected to Whisper sidecar');

      // Callback chạy trước flush để nguồn hiện tại ghi đè pending source cũ.
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
      // `ws` luôn phát close sau error. Không schedule ở đây, nếu không một lỗi
      // tạo hai timer reconnect.
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

  /** Audio realtime không queue: khi reconnect thì audio cũ đã stale. */
  sendAudio(audio: Buffer): boolean {
    return this.sendNow(audio);
  }

  /** Metadata theo từng chunk cũng drop cùng audio của chính chunk đó. */
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
      // Source hiện tại gửi thành công phải xoá pending source cũ; nếu giữ, flush
      // sẽ gửi source cũ SAU source mới và đảo namespace ngược lại.
      this.pendingSourceId = undefined;
    } else {
      // Chỉ nguồn mới nhất còn ý nghĩa.
      this.pendingSourceId = sourceId;
    }
  }

  private flushPendingControls(): void {
    // Nguồn trước, reset sau: namespace/buffer thuộc nguồn nào phải được xác lập
    // trước khi reset trạng thái của lượt tua trong nguồn đó.
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

  /** Gọi ở mọi lần open, kể cả kết nối đầu — gateway tự guard source null. */
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
