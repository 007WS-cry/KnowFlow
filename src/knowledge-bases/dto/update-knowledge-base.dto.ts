import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateKnowledgeBaseDto {
  @ApiPropertyOptional({ example: 'Team Handbook', maxLength: 120 })
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ example: 'Policies and onboarding notes', maxLength: 1000 })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(1000)
  description?: string | null;
}
