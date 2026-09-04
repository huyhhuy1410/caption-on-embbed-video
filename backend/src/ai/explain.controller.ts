import { Body, Controller, Post } from '@nestjs/common';
import { ExplainService } from './explain.service';
import { ExplainWordDto } from './dto/explain-word.dto';

@Controller('explain-word')
export class ExplainController {
  constructor(private readonly explainService: ExplainService) {}
  @Post()
  explainWord(@Body() body: ExplainWordDto) {
    return this.explainService.explainWord(body);
  }
}
