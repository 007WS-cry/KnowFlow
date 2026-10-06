import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WorkspaceRole } from '@prisma/client';

export class InviteWorkspaceMemberDto {
  @ApiProperty({ example: 'teammate@example.com' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  email!: string;

  @ApiPropertyOptional({
    enum: [WorkspaceRole.ADMIN, WorkspaceRole.MEMBER],
    default: WorkspaceRole.MEMBER,
  })
  @IsOptional()
  @IsIn([WorkspaceRole.ADMIN, WorkspaceRole.MEMBER])
  role: Extract<WorkspaceRole, 'ADMIN' | 'MEMBER'> = WorkspaceRole.MEMBER;
}
