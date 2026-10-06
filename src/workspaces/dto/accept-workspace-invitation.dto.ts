import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AcceptWorkspaceInvitationDto {
  @ApiProperty({ description: '一次性 Workspace 邀请凭证' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(32)
  @MaxLength(200)
  token!: string;
}
