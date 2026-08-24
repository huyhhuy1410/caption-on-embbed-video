import { Test, TestingModule } from '@nestjs/testing';
import { SidecarService } from './sidecar.service';

describe('SidecarService', () => {
  let service: SidecarService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SidecarService],
    }).compile();

    service = module.get<SidecarService>(SidecarService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
