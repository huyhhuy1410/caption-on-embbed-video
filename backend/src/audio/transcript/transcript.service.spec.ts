import { Test, TestingModule } from '@nestjs/testing';
import { TranscriptService } from './transcript.service';

describe('TranscriptService', () => {
  let service: TranscriptService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TranscriptService],
    }).compile();

    service = module.get<TranscriptService>(TranscriptService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
