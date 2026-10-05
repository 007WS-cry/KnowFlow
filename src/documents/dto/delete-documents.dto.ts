import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class DeleteDocumentsDto {
  @ApiProperty({ type: [String], example: ['document_id_1', 'document_id_2'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  documentIds!: string[];
}
