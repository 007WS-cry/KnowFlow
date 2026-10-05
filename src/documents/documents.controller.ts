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
import { DeleteDocumentsDto } from './dto/delete-documents.dto';
import { DocumentsService } from './documents.service';
import { UploadedFile as UploadedFilePayload } from './uploaded-file';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

@ApiTags('documents')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller()
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get('knowledge-bases/:knowledgeBaseId/documents')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('knowledgeBaseId') knowledgeBaseId: string,
  ) {
    return this.documents.list(user.id, knowledgeBaseId);
  }

  @Get('documents/:documentId')
  getStatus(@CurrentUser() user: AuthenticatedUser, @Param('documentId') id: string) {
    return this.documents.getStatus(user.id, id);
  }

  @Post('knowledge-bases/:knowledgeBaseId/documents')
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
  deleteMany(
    @CurrentUser() user: AuthenticatedUser,
    @Param('knowledgeBaseId') knowledgeBaseId: string,
    @Body() body: DeleteDocumentsDto,
  ) {
    return this.documents.deleteMany(user.id, knowledgeBaseId, body.documentIds);
  }
}
