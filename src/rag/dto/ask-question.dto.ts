import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min, MinLength, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AskQuestionDto {
  @ApiProperty({ example: '差旅报销的流程是什么？', maxLength: 4000 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  question!: string;

  @ApiPropertyOptional({ default: 5, minimum: 1, maximum: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  topK?: number;
}
