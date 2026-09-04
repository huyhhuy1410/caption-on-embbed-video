import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthController } from './health/health.controller';
import { AudioGateway } from './audio/audio.gateway';
import { SidecarService } from './audio/sidecar/sidecar.service';
import { TranscriptService } from './audio/transcript/transcript.service';
import { AiModule } from './ai/ai.module';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [
    AiModule,
    ConfigModule.forRoot({
      isGlobal: true,
    }),
  ],
  controllers: [AppController, HealthController],
  providers: [AppService, AudioGateway, SidecarService, TranscriptService],
})
export class AppModule {}
