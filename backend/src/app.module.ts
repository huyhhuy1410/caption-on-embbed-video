import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthController } from './health/health.controller';
import { AudioGateway } from './audio/audio.gateway';
import { SidecarService } from './audio/sidecar/sidecar.service';
import { TranscriptService } from './audio/transcript/transcript.service';
import { AiModule } from './ai/ai.module';
import { ConfigModule } from '@nestjs/config';
import { VideoClockService } from './audio/clock/video-clock.service';

@Module({
  imports: [
    AiModule,
    // Nạp biến môi trường (.env) toàn cục cho toàn bộ ứng dụng
    ConfigModule.forRoot({
      isGlobal: true,
    }),
  ],
  controllers: [AppController, HealthController],
  // AudioGateway, SidecarService và TranscriptService phối hợp xử lý pipeline audio
  providers: [
    AppService,
    AudioGateway,
    SidecarService,
    TranscriptService,
    VideoClockService,
  ],
})
export class AppModule {}
