import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { WebSocket } from 'ws';
@Injectable()
export class SidecarService implements OnModuleDestroy {
  private readonly socket = new WebSocket('ws://127.0.0.1:9000/ws');
  private onMessage?: (data: string) => void;
  constructor() {
    this.socket.on('open', () => {
      console.info('Connected to Whisper sidecar');
    });
    this.socket.on('message', (data) => {
      const message = data.toString();
      console.info('Message from sidecar:', message);
      this.onMessage?.(message);
    });
    this.socket.on('error', (error) => {
      console.error('Sidecar error:', error.message);
    });
    this.socket.on('close', () => {
      console.info('Disconnected from sidecar');
    });
  }
  sendAudio(audio: Buffer) {
    if (this.socket.readyState !== WebSocket.OPEN) {
      console.warn('Sidecar WebSocket is not ready');
      return;
    }
    this.socket.send(audio);
  }
  sendMetadata(metadata: unknown) {
    if (this.socket.readyState !== WebSocket.OPEN) {
      console.warn('Sidecar WebSocket is not ready');
      return;
    }

    this.socket.send(JSON.stringify(metadata));
  }
  setMessageHandler(handler: (data: string) => void) {
    this.onMessage = handler;
  }
  onModuleDestroy() {
    this.socket.close();
  }
}
