import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthModule } from './health/health.module';
import { AudioGateway } from './audio/audio.gateway';
import { SidecarService } from './audio/sidecar/sidecar.service';
import { TranscriptService } from './audio/transcript/transcript.service';
import { AiModule } from './ai/ai.module';
import { ConfigModule } from '@nestjs/config';
import { VideoClockService } from './audio/clock/video-clock.service';

@Module({
  imports: [
    AiModule,
    HealthModule,
    ConfigModule.forRoot({
      isGlobal: true,
    }),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    AudioGateway,
    SidecarService,
    TranscriptService,
    VideoClockService,
  ],
})
export class AppModule {}
