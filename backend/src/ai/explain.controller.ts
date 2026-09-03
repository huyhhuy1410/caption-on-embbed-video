import { Body, Controller, Post } from '@nestjs/common';
import { ExplainService } from './explain.service';

@Controller('explain-word')
export class ExplainController {
  constructor(private readonly explainService: ExplainService) {}
  @Post()
  explainWord(@Body() body: { word: string; context: string; lang: string }) {
    return this.explainService.explainWord(body);
  }
}
