import { Test, TestingModule } from '@nestjs/testing';

jest.mock('ws', () => ({
  WebSocket: class MockWebSocket {
    static readonly OPEN = 1;
    readonly readyState = 1;

    on() {
      return this;
    }

    close() {
      return undefined;
    }
  },
}));

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
