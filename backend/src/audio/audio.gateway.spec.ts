import { Test, TestingModule } from '@nestjs/testing';
import { AudioGateway } from './audio.gateway';
import { SidecarService } from './sidecar/sidecar.service';
import { TranscriptService } from './transcript/transcript.service';
import { VideoClockService } from './clock/video-clock.service';
import { TranslateService } from '../ai/translate.service';

describe('AudioGateway', () => {
  let gateway: AudioGateway;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AudioGateway,
        { provide: SidecarService, useValue: { setMessageHandler: jest.fn() } },
        TranscriptService,
        VideoClockService,
        // Mock: phần dịch là fire-and-forget, không phải thứ spec này kiểm tra.
        { provide: TranslateService, useValue: { translate: jest.fn() } },
      ],
    }).compile();

    gateway = module.get<AudioGateway>(AudioGateway);
  });

  it('should be defined', () => {
    expect(gateway).toBeDefined();
  });
});
