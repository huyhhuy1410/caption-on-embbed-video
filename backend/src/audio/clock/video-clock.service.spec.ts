import { Test, TestingModule } from '@nestjs/testing';
import { VideoClockService } from './video-clock.service';

describe('VideoClockService', () => {
  let service: VideoClockService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [VideoClockService],
    }).compile();
    service = module.get<VideoClockService>(VideoClockService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('first chunk: steps back CHUNK_SECONDS because there is no prior sample', () => {
    expect(service.resolveAnchor(10.0)).toBeCloseTo(9.0, 5);
  });

  it('continuous stream: chunk N anchors to chunk N-1 sample', () => {
    expect(service.resolveAnchor(10.0)).toBeCloseTo(9.0, 5);
    expect(service.resolveAnchor(11.0)).toBeCloseTo(10.0, 5);
    expect(service.resolveAnchor(12.0)).toBeCloseTo(11.0, 5);
  });

  it('paused video: video clock holds still, so the anchor holds still', () => {
    // Distinguishes pair-shift from a naive `currentVideoTime - CHUNK_SECONDS`,
    // which fails this case.
    expect(service.resolveAnchor(10.0)).toBeCloseTo(9.0, 5);
    expect(service.resolveAnchor(10.0)).toBeCloseTo(10.0, 5);
    expect(service.resolveAnchor(10.0)).toBeCloseTo(10.0, 5);
  });

  it('reset(): falls back to first-chunk behavior', () => {
    service.resolveAnchor(10.0);
    service.resolveAnchor(11.0);
    service.reset();
    // After reset there is no previous sample, so the anchor derives from current.
    expect(service.resolveAnchor(20.0)).toBeCloseTo(19.0, 5);
    expect(service.resolveAnchor(21.0)).toBeCloseTo(20.0, 5);
  });
});
