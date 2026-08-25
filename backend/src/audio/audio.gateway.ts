import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import { RawData, WebSocket } from 'ws';
import { SidecarService } from './sidecar/sidecar.service';

@WebSocketGateway()
export class AudioGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private extensionClient?: WebSocket;
  constructor(private readonly sidecarService: SidecarService) {
    this.sidecarService.setMessageHandler((data) => {
      console.info('Message from sidecar:', data);
      if (
        this.extensionClient &&
        this.extensionClient.readyState === WebSocket.OPEN
      ) {
        this.extensionClient.send(data);
      }
    });
  }
  handleConnection(client: WebSocket) {
    console.info('Extension connected to audio WebSocket');
    this.extensionClient = client;
    client.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        console.info('Received PCM bytes:', rawDataLength(data));
        const buffer = toBuffer(data);
        this.sidecarService.sendAudio(buffer);
        return;
      }

      try {
        const parsed: unknown = JSON.parse(data.toString());
        console.info('Received message:', parsed);
        this.sidecarService.sendMetadata(parsed);
      } catch {
        console.warn('Received invalid JSON message');
      }
    });
  }

  handleDisconnect() {
    console.info('Extension disconnected from audio WebSocket');
    this.extensionClient = undefined;
  }
}
function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(data));
  }

  return Buffer.from(data);
}
function rawDataLength(data: RawData): number {
  if (typeof data === 'string') return Buffer.byteLength(data);
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return data.byteLength;
}
