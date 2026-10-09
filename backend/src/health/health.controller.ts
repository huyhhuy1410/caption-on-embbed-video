import { Controller, Get } from '@nestjs/common';
import { HealthService } from './health.service';
import type { HealthState } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  check(): Promise<HealthState> {
    return this.health.check();
  }
}
