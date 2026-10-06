import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class CreateUploadDto {
  @ApiProperty({ example: 'employee-handbook.pdf', maxLength: 240 })
  @IsString()
  @MinLength(1)
  @MaxLength(240)
  originalName!: string;

  @ApiProperty({ example: 12000000 })
  @IsInt()
  @Min(1)
  sizeBytes!: number;
}
