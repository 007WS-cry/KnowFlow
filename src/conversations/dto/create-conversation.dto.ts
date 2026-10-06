import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateConversationDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  knowledgeBaseId!: string;

  @ApiProperty({ maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title!: string;
}
