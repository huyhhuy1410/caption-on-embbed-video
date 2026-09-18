import { Test, TestingModule } from '@nestjs/testing';
import { AudioGateway } from './audio.gateway';
import { SidecarService } from './sidecar/sidecar.service';
import { TranscriptService } from './transcript/transcript.service';
import { VideoClockService } from './clock/video-clock.service';

describe('AudioGateway', () => {
  let gateway: AudioGateway;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AudioGateway,
        { provide: SidecarService, useValue: { setMessageHandler: jest.fn() } },
        TranscriptService,
        VideoClockService,
      ],
    }).compile();

    gateway = module.get<AudioGateway>(AudioGateway);
  });

  it('should be defined', () => {
    expect(gateway).toBeDefined();
  });
});
