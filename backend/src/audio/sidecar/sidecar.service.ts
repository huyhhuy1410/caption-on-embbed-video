import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { WebSocket } from 'ws';

@Injectable()
export class SidecarService implements OnModuleDestroy {
  // 1. Mở kết nối WebSocket riêng nối từ NestJS Backend sang Python Sidecar (Cổng 9000)
  private readonly socket = new WebSocket('ws://127.0.0.1:9000/ws');

  // 2. Biến lưu trữ hàm callback khi có tin nhắn từ Python Sidecar trả về
  private onMessage?: (data: string) => void;

  // === BƯỚC 1: Constructor - Quản lý sự kiện socket với Python Sidecar ===
  constructor() {
    this.socket.on('open', () => {
      console.info('Connected to Whisper sidecar');
    });

    // 1.1. Lắng nghe tin nhắn Subtitle JSON từ Python Sidecar trả về
    this.socket.on('message', (data) => {
      const message = data.toString();
      console.info('Message from sidecar:', message);

      // 1.2. Kích hoạt gọi hàm callback (nếu AudioGateway đã đăng ký qua setMessageHandler)
      this.onMessage?.(message);
    });

    this.socket.on('error', (error) => {
      console.error('Sidecar error:', error.message);
    });

    this.socket.on('close', () => {
      console.info('Disconnected from sidecar');
    });
  }

  // === BƯỚC 2: Hàm gửi gói âm thanh PCM (Binary) sang Python Sidecar ===
  sendAudio(audio: Buffer) {
    if (this.socket.readyState !== WebSocket.OPEN) {
      console.warn('Sidecar WebSocket is not ready');
      return;
    }
    this.socket.send(audio);
  }

  // === BƯỚC 3: Hàm gửi gói Metadata (JSON Text) sang Python Sidecar ===
  sendMetadata(metadata: unknown) {
    if (this.socket.readyState !== WebSocket.OPEN) {
      console.warn('Sidecar WebSocket is not ready');
      return;
    }
    this.socket.send(JSON.stringify(metadata));
  }

  // === BƯỚC 3b: Báo sidecar xoá bộ đệm audio (Issue 5.21) ===
  /**
   * Gọi khi user tua. Không có lệnh này thì sidecar vẫn giữ tới 6s tiếng của
   * đoạn TRƯỚC khi tua, rồi dán mốc của đoạn SAU khi tua lên đó ⇒ cụm phụ đề
   * ngay sau lúc tua bị lệch nội dung.
   *
   * Đi cùng đường với `sendMetadata` — cùng socket, cùng định dạng JSON — để
   * sidecar chỉ cần thêm một nhánh `if` ngay chỗ nó vốn đã parse metadata.
   */
  sendReset() {
    this.sendMetadata({ type: 'reset' });
  }

  // === BƯỚC 4: Hàm Đăng ký Callback Handler từ bên ngoài (AudioGateway) ===
  setMessageHandler(handler: (data: string) => void) {
    this.onMessage = handler; // Lưu hàm handler vào biến private onMessage
  }

  // === BƯỚC 5: Giải phóng kết nối khi Module bị dọn dẹp ===
  onModuleDestroy() {
    this.socket.close();
  }
}
