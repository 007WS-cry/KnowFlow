import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import { AddressInfo } from 'node:net';
import { createServer, Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseEnv } from 'dotenv';
import request from 'supertest';
import { MinioService } from '../storage/minio.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { DOCUMENT_PROCESSING_QUEUE } from '../queue/queue.constants';
import { DocumentProcessor } from '../documents/document-processor';
import {
  calculateMetrics,
  evaluateQuestionResult,
  EvaluationQuestion,
  QueryResponse,
} from './evaluation/run-evaluation';

interface PromptSource {
  citation: number;
  documentName: string;
  content: string;
}

interface PromptRequest {
  messages: Array<{ role: string; content: string }>;
}

interface UploadedDocument {
  id: string;
  originalName: string;
  status: string;
  errorMessage?: string | null;
}

const projectRoot = process.cwd();
const savedEnvironment = new Map<string, string | undefined>();

function setTestEnvironment(key: string, value: string): void {
  if (!savedEnvironment.has(key)) savedEnvironment.set(key, process.env[key]);
  process.env[key] = value;
}

function loadLocalEnvironment(): void {
  for (const fileName of ['.env', '.env.example']) {
    try {
      const parsed = parseEnv(readFileSync(resolve(projectRoot, fileName)));
      for (const [key, value] of Object.entries(parsed)) {
        if (!process.env[key]?.trim()) {
          if (!savedEnvironment.has(key)) savedEnvironment.set(key, process.env[key]);
          process.env[key] = value;
        }
      }
      if (process.env.DATABASE_URL) return;
    } catch {
      // Try the checked-in example file if a local .env has not been created.
    }
  }
}

function databaseUrlFor(databaseUrl: string, databaseName: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${databaseName}`;
  url.searchParams.set('schema', 'public');
  return url.toString();
}

function parsePrompt(body: string): { question: string; sources: PromptSource[] } {
  const requestBody = JSON.parse(body) as PromptRequest;
  const userMessage = requestBody.messages.find((message) => message.role === 'user');
  if (!userMessage) throw new Error('LLM request has no user message');
  return JSON.parse(userMessage.content) as { question: string; sources: PromptSource[] };
}

function fakeAnswer(question: string, sources: PromptSource[]): string {
  const paris =
    question.includes('法国') &&
    sources.find((source) => source.content.includes('巴黎是法国首都'));
  if (paris) return `巴黎是法国首都。[${paris.citation}]`;

  const travel =
    question.includes('上海') &&
    sources.find(
      (source) => source.content.includes('北京、上海、深圳') && source.content.includes('600 元'),
    );
  if (travel) return `北京、上海、深圳住宿上限为每晚 600 元。[${travel.citation}]`;

  const lyon =
    question.includes('法国') &&
    sources.find((source) => source.content.includes('法国首都是里昂'));
  if (lyon) return `隔离知识库中的资料写明法国首都是里昂。[${lyon.citation}]`;

  const first = sources[0];
  if (first) return `${first.content.slice(0, 160)} [${first.citation}]`;
  return '提供的知识来源中没有足够信息回答这个问题。';
}

describe('RAG full acceptance with PostgreSQL + pgvector', () => {
  jest.setTimeout(180_000);

  let adminPrisma: PrismaClient | undefined;
  let testDatabaseName: string | undefined;
  let testDatabaseCreated = false;
  let testingModule: TestingModule | undefined;
  let app: INestApplication | undefined;
  let llmServer: Server | undefined;
  const workerErrors: string[] = [];
  const llmPrompts: Array<{ question: string; sources: PromptSource[] }> = [];

  beforeAll(async () => {
    loadLocalEnvironment();
    const configuredDatabaseUrl = process.env.DATABASE_URL;
    if (!configuredDatabaseUrl) throw new Error('为 RAG 验收测试配置 .env 中的 DATABASE_URL');

    const configuredDatabase = new URL(configuredDatabaseUrl);
    if (!['localhost', '127.0.0.1', '::1'].includes(configuredDatabase.hostname)) {
      throw new Error('验收测试只允许在 localhost PostgreSQL 上创建并销毁独立测试数据库');
    }

    const originalDatabaseUrl = configuredDatabaseUrl;
    const adminDatabaseUrl = databaseUrlFor(originalDatabaseUrl, 'postgres');
    adminPrisma = new PrismaClient({ datasources: { db: { url: adminDatabaseUrl } } });
    await adminPrisma.$connect();

    testDatabaseName = `knowflow_rag_test_${process.pid}_${Date.now()}`;
    await adminPrisma.$executeRawUnsafe(`CREATE DATABASE "${testDatabaseName}"`);
    testDatabaseCreated = true;
    const testDatabaseUrl = databaseUrlFor(originalDatabaseUrl, testDatabaseName);

    execFileSync(
      process.execPath,
      [resolve(projectRoot, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
      {
        cwd: projectRoot,
        env: { ...process.env, DATABASE_URL: testDatabaseUrl },
        stdio: 'pipe',
      },
    );

    llmServer = createServer((incoming, outgoing) => {
      const bodyChunks: Buffer[] = [];
      const requestPath = incoming.url ?? '';
      incoming.on('data', (chunk: Buffer | string) => {
        bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      incoming.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(bodyChunks).toString('utf8')) as Record<
            string,
            unknown
          >;
          outgoing.writeHead(200, { 'Content-Type': 'application/json' });
          if (requestPath.endsWith('/embeddings')) {
            const input = body.input as string[];
            outgoing.end(
              JSON.stringify({
                data: input.map((text, index) => ({ index, embedding: fakeEmbedding(text) })),
              }),
            );
          } else if (requestPath.endsWith('/rerank')) {
            const query = String(body.query ?? '');
            const documents = body.documents as string[];
            const results = documents
              .map((text, index) => ({ index, relevance_score: fakeRerankScore(query, text) }))
              .sort((left, right) => right.relevance_score - left.relevance_score);
            outgoing.end(JSON.stringify({ results }));
          } else if (requestPath.endsWith('/chat/completions')) {
            const prompt = parsePrompt(Buffer.concat(bodyChunks).toString('utf8'));
            llmPrompts.push(prompt);
            outgoing.end(
              JSON.stringify({
                choices: [{ message: { content: fakeAnswer(prompt.question, prompt.sources) } }],
              }),
            );
          } else {
            outgoing.writeHead(404);
            outgoing.end(JSON.stringify({ error: 'unknown test endpoint' }));
          }
        } catch {
          outgoing.writeHead(400, { 'Content-Type': 'application/json' });
          outgoing.end(JSON.stringify({ error: 'invalid test prompt' }));
        }
      });
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      llmServer!.once('error', rejectListen);
      llmServer!.listen(0, '127.0.0.1', resolveListen);
    });
    const llmPort = (llmServer.address() as AddressInfo).port;

    setTestEnvironment('DATABASE_URL', testDatabaseUrl);
    setTestEnvironment('NODE_ENV', 'test');
    setTestEnvironment('LLM_BASE_URL', `http://127.0.0.1:${llmPort}/v1`);
    setTestEnvironment('LLM_API_KEY', 'local-acceptance-test-key');
    setTestEnvironment('LLM_MODEL', 'acceptance-test-model');
    setTestEnvironment('EMBEDDING_PROVIDER', 'openai-compatible');
    setTestEnvironment('EMBEDDING_BASE_URL', `http://127.0.0.1:${llmPort}/v1`);
    setTestEnvironment('EMBEDDING_API_KEY', 'local-acceptance-test-key');
    setTestEnvironment('EMBEDDING_MODEL', 'acceptance-embedding-model');
    setTestEnvironment('EMBEDDING_VERSION', 'acceptance-v1');
    setTestEnvironment('EMBEDDING_DIMENSIONS', '3');
    setTestEnvironment('RERANKER_PROVIDER', 'compatible');
    setTestEnvironment('RERANKER_BASE_URL', `http://127.0.0.1:${llmPort}/v1`);
    setTestEnvironment('RERANKER_API_KEY', 'local-acceptance-test-key');
    setTestEnvironment('RERANKER_MODEL', 'acceptance-reranker');
    setTestEnvironment('BULLMQ_PREFIX', `knowflow-rag-test-${process.pid}-${Date.now()}`);

    const { AppModule } = await import('../app.module');
    testingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = testingModule.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    const worker = app.get(DocumentProcessor).worker;
    worker.on('error', (error) => workerErrors.push(error.message));
  });

  afterAll(async () => {
    if (app) {
      try {
        const prisma = app.get(PrismaService);
        const minio = app.get(MinioService);
        const queue = app.get(QueueService);
        const documents = await prisma.document.findMany({
          select: { id: true, objectKey: true },
        });
        await Promise.all(documents.map(({ id }) => queue.cancelDocumentProcessing(id)));
        await Promise.all(
          documents.map(({ objectKey }) =>
            minio
              .getClient()
              .removeObject(minio.getBucket(), objectKey)
              .catch(() => undefined),
          ),
        );
      } catch {
        // The isolated database is dropped below even if an earlier assertion failed.
      }
      await app.close().catch(() => undefined);
    } else {
      await testingModule?.close().catch(() => undefined);
    }

    if (llmServer?.listening) {
      await new Promise<void>((resolveClose) => llmServer!.close(() => resolveClose()));
    }

    for (const [key, previous] of savedEnvironment) {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }

    if (adminPrisma && testDatabaseCreated && testDatabaseName) {
      await adminPrisma
        .$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDatabaseName}" WITH (FORCE)`)
        .catch(() => undefined);
    }
    await adminPrisma?.$disconnect().catch(() => undefined);
  });

  it('registers, uploads the supplied Markdown corpus, indexes real vectors, and answers with KB-scoped sources', async () => {
    if (!app) throw new Error('Nest test app was not initialized');
    const server = app.getHttpServer();
    const documentQueue = app.get<Queue>(getQueueToken(DOCUMENT_PROCESSING_QUEUE));

    const registration = await request(server)
      .post('/api/v1/auth/register')
      .send({
        email: `rag-acceptance-${process.pid}@example.test`,
        password: 'acceptance-password',
        name: 'RAG Acceptance',
      })
      .expect(201);
    const ownerToken = registration.body.accessToken as string;
    const ownerAuth = { Authorization: `Bearer ${ownerToken}` };

    const workspace = await request(server)
      .post('/api/v1/workspaces')
      .set(ownerAuth)
      .send({ name: 'RAG acceptance workspace' })
      .expect(201);
    const targetKnowledgeBase = await request(server)
      .post(`/api/v1/workspaces/${workspace.body.id}/knowledge-bases`)
      .set(ownerAuth)
      .send({ name: 'Travel and product sources' })
      .expect(201);

    const sourceFiles = [
      [
        'knowflow-manual.md',
        resolve(projectRoot, 'test/fixtures/rag-acceptance/knowflow-manual.md'),
      ],
      [
        'security-policy.md',
        resolve(projectRoot, 'test/fixtures/rag-acceptance/security-policy.md'),
      ],
      ['travel-policy.md', resolve(projectRoot, 'test/fixtures/rag-acceptance/travel-policy.md')],
    ] as const;
    const primaryDocuments: UploadedDocument[] = [];
    for (const [filename, path] of sourceFiles) {
      const response = await request(server)
        .post(`/api/v1/knowledge-bases/${targetKnowledgeBase.body.id}/documents`)
        .set(ownerAuth)
        .attach('file', readFileSync(path), { filename, contentType: 'text/markdown' })
        .expect(201);
      primaryDocuments.push(response.body as UploadedDocument);
    }

    const semanticFixtures = [
      ['paris.md', '巴黎是法国首都。'],
      ['tokyo.md', '东京是日本首都。'],
      ['apple.md', '苹果是一种水果。'],
    ] as const;
    for (const [filename, content] of semanticFixtures) {
      const response = await request(server)
        .post(`/api/v1/knowledge-bases/${targetKnowledgeBase.body.id}/documents`)
        .set(ownerAuth)
        .attach('file', Buffer.from(content), { filename, contentType: 'text/markdown' })
        .expect(201);
      primaryDocuments.push(response.body as UploadedDocument);
    }

    const secondRegistration = await request(server)
      .post('/api/v1/auth/register')
      .send({
        email: `rag-isolation-${process.pid}@example.test`,
        password: 'acceptance-password',
        name: 'Isolated User',
      })
      .expect(201);
    const secondUserAuth = { Authorization: `Bearer ${secondRegistration.body.accessToken}` };
    const secondWorkspace = await request(server)
      .post('/api/v1/workspaces')
      .set(secondUserAuth)
      .send({ name: 'Separate workspace' })
      .expect(201);
    const isolatedKnowledgeBase = await request(server)
      .post(`/api/v1/workspaces/${secondWorkspace.body.id}/knowledge-bases`)
      .set(secondUserAuth)
      .send({ name: 'Private source' })
      .expect(201);
    const decoyResponse = await request(server)
      .post(`/api/v1/knowledge-bases/${isolatedKnowledgeBase.body.id}/documents`)
      .set(secondUserAuth)
      .attach('file', Buffer.from('法国首都是里昂。'), {
        filename: 'other-workspace-decoy.md',
        contentType: 'text/markdown',
      })
      .expect(201);
    const isolatedDocument = decoyResponse.body as UploadedDocument;

    await waitForDocumentsReady(
      server,
      ownerAuth,
      primaryDocuments.map(({ id }) => id),
      documentQueue,
      workerErrors,
    );
    await waitForDocumentsReady(
      server,
      secondUserAuth,
      [isolatedDocument.id],
      documentQueue,
      workerErrors,
    );

    const allDocuments = await app.get(PrismaService).document.findMany({
      where: {
        id: { in: [...primaryDocuments.map(({ id }) => id), isolatedDocument.id] },
      },
      select: { id: true, knowledgeBaseId: true, originalName: true, status: true },
    });
    expect(allDocuments).toHaveLength(primaryDocuments.length + 1);
    expect(allDocuments.every((document) => document.status === 'READY')).toBe(true);
    expect(
      allDocuments
        .filter((document) => primaryDocuments.some((uploaded) => uploaded.id === document.id))
        .every((document) => document.knowledgeBaseId === targetKnowledgeBase.body.id),
    ).toBe(true);

    const persistedVectors = await app.get(PrismaService).$queryRaw<
      Array<{
        total: number;
        embedded: number;
        dimensions: number;
        profileRows: number;
        model: string;
        version: string;
      }>
    >(Prisma.sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(c."embedding")::int AS embedded,
        MIN(vector_dims(c."embedding"))::int AS dimensions,
        COUNT(*) FILTER (
          WHERE c."embeddingProvider" = 'openai-compatible'
            AND c."embeddingModel" = 'acceptance-embedding-model'
            AND c."embeddingVersion" = 'acceptance-v1'
            AND c."embeddingDimension" = 3
        )::int AS "profileRows",
        MIN(c."embeddingModel") AS model,
        MIN(c."embeddingVersion") AS version
      FROM "Chunk" c
      INNER JOIN "Document" d ON d."id" = c."documentId"
      WHERE d."knowledgeBaseId" = ${targetKnowledgeBase.body.id}
    `);
    expect(persistedVectors[0]!.total).toBeGreaterThan(3);
    expect(persistedVectors[0]!.embedded).toBe(persistedVectors[0]!.total);
    expect(persistedVectors[0]!.dimensions).toBe(3);
    expect(persistedVectors[0]!.profileRows).toBe(persistedVectors[0]!.total);
    expect(persistedVectors[0]!.model).toBe('acceptance-embedding-model');
    expect(persistedVectors[0]!.version).toBe('acceptance-v1');

    const parisAnswer = await request(server)
      .post('/api/v1/query')
      .set(ownerAuth)
      .send({
        knowledgeBaseId: targetKnowledgeBase.body.id,
        question: '法国的首都是什么？',
        topK: 3,
      })
      .expect(201);
    expect(parisAnswer.body.answerMode).toBe('llm');
    expect(parisAnswer.body.answer).toContain('巴黎是法国首都');
    expect(parisAnswer.body.answer).toMatch(/\[\d+\]/);
    expect(parisAnswer.body.knowledgeBaseId).toBe(targetKnowledgeBase.body.id);
    expect(parisAnswer.body.sources.length).toBeLessThanOrEqual(3);
    expect(parisAnswer.body.sources[0].documentName).toBe('paris.md');
    expect(
      parisAnswer.body.sources.every((source: { documentId: string }) =>
        primaryDocuments.some((document) => document.id === source.documentId),
      ),
    ).toBe(true);
    expect(
      parisAnswer.body.sources
        .map((source: { documentId: string }) => source.documentId)
        .includes(isolatedDocument.id),
    ).toBe(false);

    const travelAnswer = await request(server)
      .post(`/api/v1/knowledge-bases/${targetKnowledgeBase.body.id}/query`)
      .set(ownerAuth)
      .send({ question: '上海的住宿报销上限是多少？', topK: 5, debug: true })
      .expect(201);
    expect(travelAnswer.body.answer).toContain('600 元');
    expect(travelAnswer.body.retrievalDebug.vectorCandidateCount).toBeGreaterThan(0);
    expect(travelAnswer.body.retrievalDebug.keywordCandidateCount).toBeGreaterThan(0);
    expect(
      travelAnswer.body.retrievalDebug.candidates.some(
        (candidate: { vectorRank: number | null; keywordRank: number | null }) =>
          candidate.vectorRank !== null && candidate.keywordRank !== null,
      ),
    ).toBe(true);
    expect(
      travelAnswer.body.retrievalDebug.candidates.every(
        (candidate: { fusionScore: number; rerankScore: number | null }) =>
          Number.isFinite(candidate.fusionScore) &&
          (candidate.rerankScore === null || Number.isFinite(candidate.rerankScore)),
      ),
    ).toBe(true);
    expect(
      travelAnswer.body.sources.some(
        (source: { documentName: string }) => source.documentName === 'travel-policy.md',
      ),
    ).toBe(true);

    const promptsBeforeDeniedQuery = llmPrompts.length;
    await request(server)
      .post('/api/v1/query')
      .set(ownerAuth)
      .send({
        knowledgeBaseId: isolatedKnowledgeBase.body.id,
        question: '法国首都是哪里？',
      })
      .expect(404);
    expect(llmPrompts).toHaveLength(promptsBeforeDeniedQuery);

    const isolatedAnswer = await request(server)
      .post('/api/v1/query')
      .set(secondUserAuth)
      .send({
        knowledgeBaseId: isolatedKnowledgeBase.body.id,
        question: '法国首都是哪里？',
        topK: 2,
      })
      .expect(201);
    expect(isolatedAnswer.body.answer).toContain('里昂');
    expect(isolatedAnswer.body.sources).toHaveLength(1);
    expect(isolatedAnswer.body.sources[0].documentId).toBe(isolatedDocument.id);
    expect(
      llmPrompts
        .filter((prompt) => prompt.question !== '法国首都是哪里？')
        .every((prompt) =>
          prompt.sources.every((source) => !source.documentName.includes('other-workspace-decoy')),
        ),
    ).toBe(true);

    const evaluationQuestions = JSON.parse(
      readFileSync(resolve(projectRoot, 'test/fixtures/rag-evaluation/questions.json'), 'utf8'),
    ) as EvaluationQuestion[];
    const evaluationResults = [];
    let evaluationProfile: QueryResponse['retrievalDebug']['embeddingProfile'] | undefined;
    for (const evaluationQuestion of evaluationQuestions) {
      const evaluationResponse = await request(server)
        .post(`/api/v1/knowledge-bases/${targetKnowledgeBase.body.id}/query`)
        .set(ownerAuth)
        .send({ question: evaluationQuestion.question, topK: 10, debug: true })
        .expect(201);
      const result = evaluationResponse.body as QueryResponse;
      evaluationProfile ??= result.retrievalDebug.embeddingProfile;
      evaluationResults.push(evaluateQuestionResult(evaluationQuestion, result));
    }
    const metrics = calculateMetrics(evaluationResults);
    expect(metrics.questionCount).toBe(56);

    const evaluationOutput = resolve(projectRoot, 'test/results/rag-acceptance-latest.json');
    mkdirSync(resolve(projectRoot, 'test/results'), { recursive: true });
    writeFileSync(
      evaluationOutput,
      `${JSON.stringify(
        {
          providerMode: 'deterministic-acceptance-stubs',
          embeddingProfile: evaluationProfile,
          metrics,
          results: evaluationResults,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  });

  it('enforces OWNER, ADMIN, and MEMBER permissions through the shared policy guard', async () => {
    if (!app) throw new Error('Nest test app was not initialized');
    const server = app.getHttpServer();
    const documentQueue = app.get<Queue>(getQueueToken(DOCUMENT_PROCESSING_QUEUE));
    const suffix = `${process.pid}-${Date.now()}`;
    const register = async (email: string, name: string) =>
      request(server)
        .post('/api/v1/auth/register')
        .send({ email, password: 'acceptance-password', name })
        .expect(201);

    const ownerRegistration = await register(`permissions-owner-${suffix}@example.test`, 'Owner');
    const ownerAuth = { Authorization: `Bearer ${ownerRegistration.body.accessToken}` };
    const workspace = await request(server)
      .post('/api/v1/workspaces')
      .set(ownerAuth)
      .send({ name: `Permissions ${suffix}` })
      .expect(201);
    const workspaceId = workspace.body.id as string;
    const targetKb = await request(server)
      .post(`/api/v1/workspaces/${workspaceId}/knowledge-bases`)
      .set(ownerAuth)
      .send({ name: 'Shared policy tests' })
      .expect(201);
    const knowledgeBaseId = targetKb.body.id as string;

    const adminEmail = `permissions-admin-${suffix}@example.test`;
    const ownerAdminInvite = await request(server)
      .post(`/api/v1/workspaces/${workspaceId}/invitations`)
      .set(ownerAuth)
      .send({ email: adminEmail, role: 'ADMIN' })
      .expect(201);
    const wrongRegistration = await register(
      `permissions-wrong-${suffix}@example.test`,
      'Wrong user',
    );
    await request(server)
      .post('/api/v1/invitations/accept')
      .set({ Authorization: `Bearer ${wrongRegistration.body.accessToken}` })
      .send({ token: ownerAdminInvite.body.invitationToken })
      .expect(403);
    const adminRegistration = await register(adminEmail, 'Admin');
    const adminAuth = { Authorization: `Bearer ${adminRegistration.body.accessToken}` };
    await request(server)
      .post('/api/v1/invitations/accept')
      .set(adminAuth)
      .send({ token: ownerAdminInvite.body.invitationToken })
      .expect(201);
    await request(server)
      .post('/api/v1/invitations/accept')
      .set(adminAuth)
      .send({ token: ownerAdminInvite.body.invitationToken })
      .expect(409);

    const memberEmail = `permissions-member-${suffix}@example.test`;
    const memberInvite = await request(server)
      .post(`/api/v1/workspaces/${workspaceId}/invitations`)
      .set(adminAuth)
      .send({ email: memberEmail, role: 'MEMBER' })
      .expect(201);
    const memberRegistration = await register(memberEmail, 'Member');
    const memberAuth = { Authorization: `Bearer ${memberRegistration.body.accessToken}` };
    await request(server)
      .post('/api/v1/invitations/accept')
      .set(memberAuth)
      .send({ token: memberInvite.body.invitationToken })
      .expect(201);

    const membersResponse = await request(server)
      .get(`/api/v1/workspaces/${workspaceId}/members`)
      .set(ownerAuth)
      .expect(200);
    expect(membersResponse.body.map((member: { role: string }) => member.role).sort()).toEqual([
      'ADMIN',
      'MEMBER',
      'OWNER',
    ]);

    const ownerDocument = (
      await request(server)
        .post(`/api/v1/knowledge-bases/${knowledgeBaseId}/documents`)
        .set(ownerAuth)
        .attach('file', Buffer.from('所有者上传的共享测试资料。'), {
          filename: 'owner-shared.md',
          contentType: 'text/markdown',
        })
        .expect(201)
    ).body as UploadedDocument;
    const memberDocument = (
      await request(server)
        .post(`/api/v1/knowledge-bases/${knowledgeBaseId}/documents`)
        .set(memberAuth)
        .attach('file', Buffer.from('成员上传的团队查询测试资料。'), {
          filename: 'member-owned.md',
          contentType: 'text/markdown',
        })
        .expect(201)
    ).body as UploadedDocument;
    await waitForDocumentsReady(
      server,
      ownerAuth,
      [ownerDocument.id, memberDocument.id],
      documentQueue,
      workerErrors,
    );

    await request(server)
      .get(`/api/v1/workspaces/${workspaceId}/knowledge-bases`)
      .set(memberAuth)
      .expect(200);
    await request(server)
      .post(`/api/v1/workspaces/${workspaceId}/knowledge-bases`)
      .set(memberAuth)
      .send({ name: 'Member cannot create this' })
      .expect(403);
    await request(server)
      .patch(`/api/v1/workspaces/${workspaceId}`)
      .set(memberAuth)
      .send({ name: 'Member cannot rename this' })
      .expect(403);
    await request(server)
      .post(`/api/v1/workspaces/${workspaceId}/invitations`)
      .set(memberAuth)
      .send({ email: `blocked-${suffix}@example.test`, role: 'MEMBER' })
      .expect(403);
    await request(server)
      .get(`/api/v1/workspaces/${workspaceId}/invitations`)
      .set(memberAuth)
      .expect(403);
    await request(server)
      .delete(`/api/v1/knowledge-bases/${knowledgeBaseId}/documents`)
      .set(memberAuth)
      .send({ documentIds: [ownerDocument.id] })
      .expect(403);
    expect(await app.get(PrismaService).document.count({ where: { id: ownerDocument.id } })).toBe(
      1,
    );
    await request(server)
      .delete(`/api/v1/knowledge-bases/${knowledgeBaseId}/documents`)
      .set(memberAuth)
      .send({ documentIds: [memberDocument.id] })
      .expect(200);
    const memberQuery = await request(server)
      .post(`/api/v1/knowledge-bases/${knowledgeBaseId}/query`)
      .set(memberAuth)
      .send({ question: '团队资料里有哪些信息？', topK: 3 })
      .expect(201);
    expect(memberQuery.body.knowledgeBaseId).toBe(knowledgeBaseId);

    const adminKnowledgeBase = await request(server)
      .post(`/api/v1/workspaces/${workspaceId}/knowledge-bases`)
      .set(adminAuth)
      .send({ name: 'Admin managed KB' })
      .expect(201);
    await request(server)
      .patch(`/api/v1/knowledge-bases/${knowledgeBaseId}`)
      .set(adminAuth)
      .send({ description: 'Updated by admin' })
      .expect(200);
    await request(server)
      .post(`/api/v1/workspaces/${workspaceId}/invitations`)
      .set(adminAuth)
      .send({ email: `blocked-admin-${suffix}@example.test`, role: 'ADMIN' })
      .expect(403);
    await request(server)
      .patch(`/api/v1/workspaces/${workspaceId}/members/${memberRegistration.body.user.id}`)
      .set(adminAuth)
      .send({ role: 'ADMIN' })
      .expect(403);
    await request(server)
      .delete(`/api/v1/workspaces/${workspaceId}/members/${ownerRegistration.body.user.id}`)
      .set(adminAuth)
      .expect(403);
    await request(server)
      .delete(`/api/v1/workspaces/${workspaceId}/members/${adminRegistration.body.user.id}`)
      .set(adminAuth)
      .expect(403);
    await request(server)
      .patch(`/api/v1/workspaces/${workspaceId}`)
      .set(adminAuth)
      .send({ name: 'Admin cannot rename this' })
      .expect(403);
    await request(server)
      .delete(`/api/v1/knowledge-bases/${knowledgeBaseId}/documents`)
      .set(adminAuth)
      .send({ documentIds: [ownerDocument.id] })
      .expect(200);
    await request(server)
      .delete(`/api/v1/knowledge-bases/${adminKnowledgeBase.body.id}`)
      .set(adminAuth)
      .expect(200);
    await request(server).delete(`/api/v1/workspaces/${workspaceId}`).set(adminAuth).expect(403);

    await request(server)
      .patch(`/api/v1/workspaces/${workspaceId}/members/${memberRegistration.body.user.id}`)
      .set(ownerAuth)
      .send({ role: 'ADMIN' })
      .expect(200);
    await request(server)
      .post(`/api/v1/workspaces/${workspaceId}/knowledge-bases`)
      .set(memberAuth)
      .send({ name: 'Promoted member can manage KBs' })
      .expect(201);
    await request(server)
      .patch(`/api/v1/workspaces/${workspaceId}/members/${memberRegistration.body.user.id}`)
      .set(ownerAuth)
      .send({ role: 'MEMBER' })
      .expect(200);
    await request(server)
      .delete(`/api/v1/workspaces/${workspaceId}/members/${memberRegistration.body.user.id}`)
      .set(adminAuth)
      .expect(200);
    await request(server)
      .get(`/api/v1/workspaces/${workspaceId}/members`)
      .set(memberAuth)
      .expect(404);

    await request(server)
      .patch(`/api/v1/workspaces/${workspaceId}`)
      .set(ownerAuth)
      .send({ name: 'Owner updated this workspace' })
      .expect(200);
    await request(server)
      .delete(`/api/v1/workspaces/${workspaceId}/members/${ownerRegistration.body.user.id}`)
      .set(ownerAuth)
      .expect(403);
    await request(server).delete(`/api/v1/workspaces/${workspaceId}`).set(ownerAuth).expect(200);
  });
});

async function waitForDocumentsReady(
  server: ReturnType<INestApplication['getHttpServer']>,
  authorization: Record<string, string>,
  documentIds: string[],
  queue: Queue,
  workerErrors: string[],
): Promise<void> {
  const remaining = new Set(documentIds);
  const deadline = Date.now() + 30_000;

  while (remaining.size > 0 && Date.now() < deadline) {
    for (const id of [...remaining]) {
      const response = await request(server).get(`/api/v1/documents/${id}`).set(authorization);
      if (response.status !== 200)
        throw new Error(`无法查询文档 ${id} 状态：HTTP ${response.status}`);
      const document = response.body as UploadedDocument;
      if (document.status === 'FAILED') {
        throw new Error(
          `文档 ${document.originalName} 处理失败：${document.errorMessage ?? '无错误详情'}`,
        );
      }
      if (document.status === 'READY') remaining.delete(id);
    }
    if (remaining.size > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }

  if (remaining.size > 0) {
    const diagnostics = await Promise.all(
      [...remaining].map(async (id) => {
        const [job, status] = await Promise.all([
          queue.getJob(id),
          request(server).get(`/api/v1/documents/${id}`).set(authorization),
        ]);
        return {
          id,
          status: status.body.status,
          jobState: job ? await job.getState() : 'missing',
          jobAttemptsMade: job?.attemptsMade,
        };
      }),
    );
    throw new Error(
      `文档处理超时，仍未完成：${JSON.stringify(diagnostics)}；Worker 错误：${workerErrors.join(' | ') || '无'}`,
    );
  }
}

function fakeEmbedding(text: string): number[] {
  if (text.includes('法国') || text.includes('巴黎')) return [1, 0, 0];
  if (text.includes('上海') || text.includes('住宿') || text.includes('差旅')) return [0, 1, 0];
  if (text.includes('安全') || text.includes('Git') || text.includes('API Key')) return [0, 0, 1];
  return [0.57735027, 0.57735027, 0.57735027];
}

function fakeRerankScore(query: string, content: string): number {
  if (query.includes('法国') && content.includes('巴黎是法国首都')) return 1;
  if (query.includes('上海') && content.includes('600 元')) return 1;
  const queryChars = [...new Set(Array.from(query.replace(/[\s，。？?]/gu, '')))];
  const matches = queryChars.filter((character) => content.includes(character)).length;
  return matches / Math.max(queryChars.length, 1);
}
