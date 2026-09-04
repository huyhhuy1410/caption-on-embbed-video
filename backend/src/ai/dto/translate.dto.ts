import { IsString, IsNotEmpty } from 'class-validator';

/** Request body for POST /translate. Validated at runtime by the global ValidationPipe. */
export class TranslateDto {
  @IsString()
  @IsNotEmpty()
  sentence: string;

  @IsString()
  @IsNotEmpty()
  from: string;

  @IsString()
  @IsNotEmpty()
  to: string;
}
