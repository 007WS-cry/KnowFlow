import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AuthGuard } from '../auth/auth.guard';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { UploadedFile } from './uploaded-file';

describe('DocumentsController multipart filename encoding', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  const upload = jest.fn(async (_userId: string, _knowledgeBaseId: string, file?: UploadedFile) => ({
    originalName: file?.originalname,
  }));

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      controllers: [DocumentsController],
      providers: [{ provide: DocumentsService, useValue: { upload } }],
    })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (context: { switchToHttp: () => { getRequest: () => { user?: unknown } } }) => {
          context.switchToHttp().getRequest().user = {
            id: 'user-1',
            email: 'user@example.com',
            name: null,
          };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => jest.clearAllMocks());

  it('preserves Chinese filenames parsed from multipart/form-data', async () => {
    const filename = 'KnowFlow 企业知识库平台使用手册.md';

    const response = await request(app.getHttpServer())
      .post('/api/v1/knowledge-bases/kb-1/documents')
      .attach('file', Buffer.from('# KnowFlow'), {
        filename,
        contentType: 'text/markdown',
      })
      .expect(201);

    expect(response.body).toEqual({ originalName: filename });
    expect(upload).toHaveBeenCalledWith(
      'user-1',
      'kb-1',
      expect.objectContaining({ originalname: filename }),
    );
  });
});
