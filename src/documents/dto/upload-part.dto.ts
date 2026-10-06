import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

export class UploadPartDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  partNumber!: number;
}
