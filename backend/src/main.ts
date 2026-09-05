import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { WsAdapter } from '@nestjs/platform-ws';
async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // Cho phép request từ extension và các origin khác
  app.enableCors();

  // Tự động validate DTO payload và loại bỏ các trường không khai báo
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Sử dụng thư viện 'ws' làm adapter WebSocket thay vì socket.io mặc định
  app.useWebSocketAdapter(new WsAdapter(app));

  const port = process.env.PORT ?? 8000;
  await app.listen(port);
  logger.log(`Backend application is running on port ${port}`);
}
bootstrap();
