import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import {
  documentParam,
  knowledgeBaseParam,
  RequireWorkspacePermission,
} from '../authorization/workspace-permissions';
import { WorkspacePolicyGuard } from '../authorization/workspace-policy.guard';
import { DeleteDocumentsDto } from './dto/delete-documents.dto';
import { DocumentsService } from './documents.service';
import { UploadedFile as UploadedFilePayload } from './uploaded-file';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

@ApiTags('documents')
@ApiBearerAuth()
@UseGuards(AuthGuard, WorkspacePolicyGuard)
@Controller()
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get('knowledge-bases/:knowledgeBaseId/documents')
  @RequireWorkspacePermission('DOCUMENT_VIEW', knowledgeBaseParam('knowledgeBaseId'))
  list(@Param('knowledgeBaseId') knowledgeBaseId: string) {
    return this.documents.list(knowledgeBaseId);
  }

  @Get('documents/:documentId')
  @RequireWorkspacePermission('DOCUMENT_VIEW', documentParam('documentId'))
  getStatus(@Param('documentId') id: string) {
    return this.documents.getStatus(id);
  }

  @Post('knowledge-bases/:knowledgeBaseId/documents')
  @RequireWorkspacePermission('DOCUMENT_UPLOAD', knowledgeBaseParam('knowledgeBaseId'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      defParamCharset: 'utf8',
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    }),
  )
  upload(
    @CurrentUser() user: AuthenticatedUser,
    @Param('knowledgeBaseId') knowledgeBaseId: string,
    @UploadedFile() file?: UploadedFilePayload,
  ) {
    return this.documents.upload(user.id, knowledgeBaseId, file);
  }

  @Delete('knowledge-bases/:knowledgeBaseId/documents')
  @RequireWorkspacePermission('DOCUMENT_DELETE', knowledgeBaseParam('knowledgeBaseId'))
  deleteMany(@Param('knowledgeBaseId') knowledgeBaseId: string, @Body() body: DeleteDocumentsDto) {
    return this.documents.deleteMany(knowledgeBaseId, body.documentIds);
  }
}
