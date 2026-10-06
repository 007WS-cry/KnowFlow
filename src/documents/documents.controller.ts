import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
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
import { CreateUploadDto } from './dto/create-upload.dto';
import { UploadPartDto } from './dto/upload-part.dto';
import { DocumentsService } from './documents.service';

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

  @Post('knowledge-bases/:knowledgeBaseId/documents/uploads')
  @RequireWorkspacePermission('DOCUMENT_UPLOAD', knowledgeBaseParam('knowledgeBaseId'))
  createUpload(
    @CurrentUser() user: AuthenticatedUser,
    @Param('knowledgeBaseId') knowledgeBaseId: string,
    @Body() body: CreateUploadDto,
  ) {
    return this.documents.createUploadTask(user.id, knowledgeBaseId, body);
  }

  @Post('documents/:documentId/uploads/parts/url')
  @RequireWorkspacePermission('DOCUMENT_PROCESS', documentParam('documentId'))
  partUploadUrl(@Param('documentId') documentId: string, @Body() body: UploadPartDto) {
    return this.documents.getPartUploadUrl(documentId, body.partNumber);
  }

  @Post('documents/:documentId/uploads/complete')
  @RequireWorkspacePermission('DOCUMENT_PROCESS', documentParam('documentId'))
  completeUpload(@Param('documentId') documentId: string) {
    return this.documents.completeUpload(documentId);
  }

  @Post('documents/:documentId/retry')
  @RequireWorkspacePermission('DOCUMENT_PROCESS', documentParam('documentId'))
  retry(@Param('documentId') documentId: string) {
    return this.documents.retry(documentId);
  }

  @Post('documents/:documentId/reindex')
  @RequireWorkspacePermission('DOCUMENT_PROCESS', documentParam('documentId'))
  reindex(@Param('documentId') documentId: string) {
    return this.documents.retry(documentId, true);
  }

  @Post('documents/:documentId/cancel')
  @RequireWorkspacePermission('DOCUMENT_PROCESS', documentParam('documentId'))
  cancel(@Param('documentId') documentId: string) {
    return this.documents.cancel(documentId);
  }

  @Delete('knowledge-bases/:knowledgeBaseId/documents')
  @RequireWorkspacePermission('DOCUMENT_DELETE', knowledgeBaseParam('knowledgeBaseId'))
  deleteMany(@Param('knowledgeBaseId') knowledgeBaseId: string, @Body() body: DeleteDocumentsDto) {
    return this.documents.deleteMany(knowledgeBaseId, body.documentIds);
  }
}
