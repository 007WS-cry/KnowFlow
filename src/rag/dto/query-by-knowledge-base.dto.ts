import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { AskQuestionDto } from './ask-question.dto';

export class QueryByKnowledgeBaseDto extends AskQuestionDto {
  @ApiProperty({ example: 'clx123knowledgebaseid' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  knowledgeBaseId!: string;
}
