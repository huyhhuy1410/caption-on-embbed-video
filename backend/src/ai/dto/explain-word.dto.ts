import { IsString, IsNotEmpty } from 'class-validator';

/** Request body for POST /explain-word. Validated at runtime by the global ValidationPipe. */
export class ExplainWordDto {
  @IsString()
  @IsNotEmpty()
  word: string;

  @IsString()
  @IsNotEmpty()
  context: string;

  @IsString()
  @IsNotEmpty()
  lang: string;
}
