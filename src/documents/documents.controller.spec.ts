import { Test, TestingModule } from '@nestjs/testing';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspacePolicyGuard } from '../authorization/workspace-policy.guard';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';

describe('DocumentsController direct upload API', () => {
  const createUploadTask = jest.fn(
    async (
      _userId: string,
      _knowledgeBaseId: string,
      input: { originalName: string; sizeBytes: number },
    ) => ({
      document: { id: 'doc-1', originalName: input.originalName },
      uploadMode: 'single',
      uploadUrl: 'https://minio.test/upload',
    }),
  );

  let controller: DocumentsController;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [DocumentsController],
      providers: [{ provide: DocumentsService, useValue: { createUploadTask } }],
    })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (context: {
          switchToHttp: () => { getRequest: () => { user?: unknown } };
        }) => {
          context.switchToHttp().getRequest().user = {
            id: 'user-1',
            email: 'user@example.com',
            name: null,
          };
          return true;
        },
      })
      .overrideGuard(WorkspacePolicyGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get(DocumentsController);
  });

  beforeEach(() => jest.clearAllMocks());

  it('creates a metadata-only upload task and preserves UTF-8 filenames', async () => {
    const filename = 'KnowFlow 企业知识库平台使用手册.md';
    const result = await controller.createUpload(
      { id: 'user-1', email: 'user@example.com', name: null },
      'kb-1',
      { originalName: filename, sizeBytes: 1024 },
    );
    expect(result.document.originalName).toBe(filename);
    expect(createUploadTask).toHaveBeenCalledWith('user-1', 'kb-1', {
      originalName: filename,
      sizeBytes: 1024,
    });
  });
});
