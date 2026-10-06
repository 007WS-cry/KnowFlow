import { IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { WorkspaceRole } from '@prisma/client';

export class UpdateWorkspaceMemberDto {
  @ApiProperty({ enum: [WorkspaceRole.ADMIN, WorkspaceRole.MEMBER] })
  @IsIn([WorkspaceRole.ADMIN, WorkspaceRole.MEMBER])
  role!: Extract<WorkspaceRole, 'ADMIN' | 'MEMBER'>;
}
