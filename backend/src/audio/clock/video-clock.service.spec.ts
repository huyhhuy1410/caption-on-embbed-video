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

  it('chunk đầu tiên: lùi đúng CHUNK_SECONDS vì chưa có mẫu trước', () => {
    expect(service.resolveAnchor(10.0)).toBeCloseTo(9.0, 5);
  });

  it('chuỗi liên tục: anchor của chunk N = mẫu của chunk N-1', () => {
    expect(service.resolveAnchor(10.0)).toBeCloseTo(9.0, 5);
    expect(service.resolveAnchor(11.0)).toBeCloseTo(10.0, 5);
    expect(service.resolveAnchor(12.0)).toBeCloseTo(11.0, 5);
  });

  it('video pause: video clock đứng yên thì anchor cũng đứng yên', () => {
    // Ca này phân biệt pair-shift với phép trừ 1.0. Nếu lỡ viết
    // `currentVideoTime - CHUNK_SECONDS` thì test này fail.
    expect(service.resolveAnchor(10.0)).toBeCloseTo(9.0, 5);
    expect(service.resolveAnchor(10.0)).toBeCloseTo(10.0, 5);
    expect(service.resolveAnchor(10.0)).toBeCloseTo(10.0, 5);
  });

  it('reset(): quay lại hành vi chunk đầu tiên', () => {
    service.resolveAnchor(10.0);
    service.resolveAnchor(11.0);
    service.reset();
    // Sau reset, không còn mẫu trước ⇒ phải suy ra từ current.
    expect(service.resolveAnchor(20.0)).toBeCloseTo(19.0, 5);
    // Và mẫu mới đã được ghi lại.
    expect(service.resolveAnchor(21.0)).toBeCloseTo(20.0, 5);
  });
});
