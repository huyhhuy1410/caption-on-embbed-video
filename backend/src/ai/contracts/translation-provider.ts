import { Translation } from '../types/translation';

export interface TranslationProvider {
  readonly name: string;
  translate(sentence: string, to: string, from: string): Promise<Translation>;
}
