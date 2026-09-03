import { Body, Controller, Post } from '@nestjs/common';
import { TranslateService } from './translate.service';

@Controller('translate')
export class TranslateController {
  constructor(private readonly translateService: TranslateService) {}
  @Post()
  translate(@Body() body: { sentence: string; from: string; to: string }) {
    return this.translateService.translate(body);
  }
}
