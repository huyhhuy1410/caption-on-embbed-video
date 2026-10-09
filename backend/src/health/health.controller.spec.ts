import { Test } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { HealthModule } from './health.module';
import { HealthService } from './health.service';
import type { HealthState } from './health.service';

describe('HealthController', () => {
  it('returns the service readiness contract without masking loading', async () => {
    const state: HealthState = {
      backend: 'ready',
      sidecar: 'loading',
      model: 'tiny',
      mode: 'streaming',
    };
    const check = jest.fn().mockResolvedValue(state);
    const module = await Test.createTestingModule({ imports: [HealthModule] })
      .overrideProvider(HealthService)
      .useValue({ check })
      .compile();
    expect(await module.get(HealthController).check()).toEqual(state);
    expect(check).toHaveBeenCalledTimes(1);
    await module.close();
  });

  it('registers and exports HealthService from HealthModule', async () => {
    const module = await Test.createTestingModule({
      imports: [HealthModule],
    }).compile();
    expect(module.get(HealthService)).toBeInstanceOf(HealthService);
    expect(module.get(HealthController)).toBeInstanceOf(HealthController);
    await module.close();
  });
});
