import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import { RawData, WebSocket } from 'ws';
import { SidecarService } from './sidecar/sidecar.service';
import { TranscriptService } from './transcript/transcript.service';
import { VideoClockService } from './clock/video-clock.service';

@WebSocketGateway()
export class AudioGateway implements OnGatewayConnection, OnGatewayDisconnect {
  // Biến lưu trữ tham chiếu WebSocket client của Extension Chrome đang kết nối
  private extensionClient?: WebSocket;

  // === BƯỚC 1: Constructor - Thiết lập kết nối hai chiều với Sidecar Service ===
  constructor(
    private readonly sidecarService: SidecarService,
    private readonly transcriptService: TranscriptService,
    private readonly videoClockService: VideoClockService,
  ) {
    // 1.1. Đăng ký callback lắng nghe kết quả Subtitle trả về từ Python Sidecar
    this.sidecarService.setMessageHandler((data) => {
      console.info('Message from sidecar:', data);

      // 1.2. Nếu Extension đang mở kết nối, bắn thẳng kết quả JSON về cho Extension!

      const message = data.toString();
      try {
        const parsedMessage = JSON.parse(message);
        if (parsedMessage.type === 'words') {
          this.transcriptService.addWords(parsedMessage.words);
        }
      } catch (error) {
        console.warn('Failed to parse message', error);
      }
      if (
        this.extensionClient &&
        this.extensionClient.readyState === WebSocket.OPEN
      ) {
        this.extensionClient.send(message);
      }
    });
  }

  // === BƯỚC 2: Sự kiện khi Extension Chrome mở kết nối WebSocket (Cổng 8000) ===
  handleConnection(client: WebSocket) {
    console.info('Extension connected to audio WebSocket');
    this.extensionClient = client; // Lưu tham chiếu client vào cấp Class

    client.on('error', (err) => {
      console.error('Extension audio WebSocket error:', err);
    });

    // 2.1. Lắng nghe từng gói tin từ Extension gửi lên
    client.on('message', (data: RawData, isBinary: boolean) => {
      // Nhánh A: Nếu là dữ liệu Nhị phân (PCM Audio Bytes)
      if (isBinary) {
        console.info('Received PCM bytes:', rawDataLength(data));
        const buffer = toBuffer(data);
        this.sidecarService.sendAudio(buffer); // Forward mảng byte cho Sidecar Python
        return;
      }

      // Nhánh B: Nếu là dữ liệu Chữ (JSON Metadata)
      try {
        const parsed: unknown = JSON.parse(data.toString());
        console.info('Received message:', parsed);
        if (isRecord(parsed) && parsed.type === 'seek') {
          const seekTime = (parsed as { seekTimeAtCapture?: number })
            .seekTimeAtCapture;
          console.info('Backend: seek received', parsed);
          if (seekTime !== undefined) {
            this.videoClockService.reset();

            const from = seekTime;
            const to = seekTime + 3;
            const replayWords = this.transcriptService.getRange(from, to);
            console.info('Seek received:', seekTime);
            console.info('Replay words:', replayWords.length);
            if (
              this.extensionClient &&
              this.extensionClient.readyState === WebSocket.OPEN
            ) {
              this.extensionClient.send(
                JSON.stringify({
                  type: 'replay',
                  seekTime,
                  words: replayWords,
                }),
              );
            }
          }
        } else {
          // Gắn lại anchor: video time tại ĐẦU audio của chunk này, không phải
          // tại lúc gửi. Xem VideoClockService.
          const withAnchor =
            isRecord(parsed) && typeof parsed.videoTimeAtCapture === 'number'
              ? {
                  ...parsed,
                  videoTimeAtCapture: this.videoClockService.resolveAnchor(
                    parsed.videoTimeAtCapture,
                  ),
                }
              : parsed;
          this.sidecarService.sendMetadata(withAnchor);
        }
      } catch {
        console.warn('Received invalid JSON message');
      }
    });
  }

  // === BƯỚC 3: Sự kiện khi Extension ngắt kết nối ===
  handleDisconnect() {
    console.info('Extension disconnected from audio WebSocket');
    this.extensionClient = undefined; // Dọn dẹp biến tham chiếu
  }
}

// === BƯỚC 4: Helper chuyển đổi dữ liệu thô RawData thành Node.js Buffer ===
function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(data)); // Đọc ArrayBuffer bằng kính Uint8Array
  }

  return Buffer.from(data);
}

// === BƯỚC 5: Helper tính độ dài dung lượng (Byte length) của RawData ===
function rawDataLength(data: RawData): number {
  if (typeof data === 'string') return Buffer.byteLength(data);
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return data.byteLength;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
