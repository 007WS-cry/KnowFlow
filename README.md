# KnowFlow

KnowFlow 是一个轻量知识库 RAG MVP，提供 Vue + Element Plus 前端和 NestJS + TypeScript 后端，支持用户登录、Workspace、知识库、文档处理与向量检索。

## 技术栈

- Node.js 22.12+、TypeScript、NestJS 11
- Vue 3、Element Plus、Vite 7、TypeScript
- PostgreSQL 16 + pgvector、Prisma ORM 6
- Redis 7、BullMQ
- MinIO
- Docker、Docker Compose、Jest

## 快速启动

Windows PowerShell：

```powershell
Copy-Item .env.example .env
docker compose up -d --build
```

服务启动后可访问：

- API：<http://localhost:8000/api/v1>
- 健康检查：<http://localhost:8000/api/v1/health>
- Swagger：<http://localhost:8000/docs>
- MinIO S3 API：<http://localhost:9000>

Compose 会在 API 启动前执行 Prisma 迁移，并自动创建 MinIO bucket。停止服务使用 `docker compose down`；删除本地数据库、Redis 和文件数据卷使用 `docker compose down -v`。

本地运行 NestJS 时，先启动依赖并执行迁移：

```powershell
Copy-Item .env.example .env
docker compose up -d postgres redis minio
npm install
npm run prisma:generate
npm run prisma:migrate:deploy
npm run start:dev
```

## Web 前端

前端代码位于 `frontend/`，使用 Vue 3、Element Plus 和 Vite。开发服务器运行在 `http://localhost:3000`，并将 `/api/v1` 请求代理到本机 `http://localhost:8000`。前端使用浏览器本地存储保存登录会话；不依赖外部字体或图片服务。

在后端按上一节启动后，另开一个 PowerShell 窗口运行：

```powershell
cd frontend
npm install
npm run dev
```

然后在浏览器打开 <http://localhost:3000>，注册或登录即可使用。也可以直接从项目根目录执行 `npm run frontend:dev` 和 `npm run frontend:build`。若要向非空知识库提问，请在根目录 `.env` 中配置 `LLM_API_KEY`；登录、知识库管理和文档上传不依赖该密钥。

### 修改源代码后重启

- 本地运行 API（`npm run start:dev`）：Nest watch 通常会自动重启；如未重启，在 API 终端按 `Ctrl+C` 后重新运行 `npm run start:dev`。
- API 运行在 Docker Compose 中：执行 `docker compose up -d --build api` 重建并启动 API 容器。
- 前端运行在 Vite 开发服务器中：通常会自动热更新；如已停止，在项目根目录运行 `npm run frontend:dev`，然后刷新浏览器。

仅修改 TypeScript 源码不需要重新生成 Prisma Client 或运行数据库迁移。只有修改 Prisma schema 或迁移文件时才需要执行相应的 Prisma 命令。

## MVP 操作流程

API 路径前缀为 `/api/v1`。除注册和登录外，其他业务请求需带上 `Authorization: Bearer <accessToken>`。注册或登录后按下面顺序调用：

1. `POST /auth/register` 或 `POST /auth/login` 获取 access token；`GET /auth/me` 获取当前用户，`POST /auth/logout` 退出。
2. Workspace 支持 `POST /workspaces` 创建、`GET /workspaces` 列表、`GET /workspaces/{workspaceId}` 详情、`PATCH /workspaces/{workspaceId}` 更新和 `DELETE /workspaces/{workspaceId}` 删除。只有 Workspace 所有者可以更新或删除。
3. Knowledge Base 使用 `POST`、`GET /workspaces/{workspaceId}/knowledge-bases` 创建和列表；单项详情、更新、删除使用 `GET`、`PATCH`、`DELETE /knowledge-bases/{knowledgeBaseId}`。所有操作均要求用户属于该 Workspace。
4. `GET /knowledge-bases/{knowledgeBaseId}/documents` 查看文档。新建知识库默认返回空数组。
5. `POST /knowledge-bases/{knowledgeBaseId}/documents` 以 `multipart/form-data` 上传字段 `file`。支持 TXT、Markdown、PDF、DOCX，默认最大 10 MB。上传文件名按 UTF-8 解码；早期因 Latin-1 解码保存的中文乱码文件名会在列表、状态和 RAG 引用响应中自动恢复显示。文档进入 BullMQ 后台处理，轮询文档列表或 `GET /documents/{documentId}` 可查看 `PENDING`、`PROCESSING`、`READY` 或 `FAILED` 状态。
6. `DELETE /knowledge-bases/{knowledgeBaseId}/documents` 按 ID 批量删除：`{"documentIds":["doc_id_1","doc_id_2"]}`。这会同时删除 MinIO 对象和 PostgreSQL 中的文档及 chunks。
7. `POST /query` 提问：`{"knowledgeBaseId":"kb_id","question":"差旅报销的流程是什么？","topK":5}`。响应包含 LLM `answer`、命中 `chunks`、`sources` 与 `citations`。旧路径 `POST /knowledge-bases/{knowledgeBaseId}/query` 仍可使用。

注册请求示例：

```json
{
  "email": "user@example.com",
  "password": "change-this-password",
  "name": "KnowFlow User"
}
```

登录采用数据库会话 token；数据库只保存 token 的 SHA-256 摘要，密码使用 Node.js scrypt 哈希。注册后还需创建 Workspace，服务不会替用户隐式创建知识库。

Workspace、知识库、文档和 RAG 查询均按当前用户的 Workspace 成员关系隔离。Workspace 或知识库删除时，会尝试取消关联文档任务并清理 MinIO 对象，再删除数据库记录。

## RAG 与数据模型

文档原文件存入 MinIO。后台 Worker 抽取文本、按约 1,200 字切块、计算 1,536 维本地特征向量并写入 PostgreSQL + pgvector；上传成功后会自动入队，无需手动刷新。提问时先校验用户对知识库的 Workspace 访问权，再将问题转为同维向量，通过参数化 SQL 在该知识库/Workspace 内执行 pgvector 余弦相似度检索，取 Top K chunks 后调用 OpenAI 兼容的 Chat Completions API，返回回答和来源引用。空知识库会返回提示与空来源，不调用 LLM。

本地 MVP 的 embedding 使用词项与中英文字符 n-gram 的稳定特征哈希，不是 Transformer 语义模型。设置 `.env` 中的 `LLM_BASE_URL`、`LLM_API_KEY` 和 `LLM_MODEL` 后即可生成回答；未配置 API key 时，非空知识库的 query 会返回服务不可用错误。默认 LLM 地址为 OpenAI API，也可以指定兼容 Chat Completions 的服务。不要把真实密钥提交到版本控制。

初始迁移启用 `vector` 扩展并为 `Chunk.embedding` 建立余弦 HNSW 索引。Prisma 将 pgvector 列声明为 `Unsupported`，向量写入和距离检索通过参数化 raw SQL 完成。若以后更换 Embedding 模型，需同步调整向量维度、迁移和索引。

## 目录结构

```text
prisma/                   # Prisma schema 与 SQL migrations
src/
  auth/                   # 注册、登录、会话 guard
  config/                 # 环境变量校验
  documents/              # 上传、列表、删除、BullMQ 处理器
  embeddings/             # 本地 1536 维 embedding
  health/                 # 健康检查
  knowledge-bases/        # 知识库 CRUD 与成员权限检查
  prisma/                 # Prisma client 生命周期
  queue/                  # BullMQ 队列
  rag/                    # pgvector 检索、访问范围过滤与 RAG 查询
  llm/                    # OpenAI 兼容 Chat Completions 客户端
  storage/                # MinIO client 与 bucket
  workspaces/             # Workspace CRUD 与成员权限检查
frontend/                 # Vue 3 + Element Plus 知识工作台
  src/api.ts              # 带会话认证的后端 API 客户端
  src/components/         # 登录页与知识库工作区
test/                     # Jest e2e 配置
Dockerfile
Dockerfile.minio          # 从固定 MinIO 官方源码版本构建本地镜像
docker-compose.yml
```

Compose 从 MinIO 官方源码构建固定版本并提供本地 S3 API。MinIO 上游仓库已归档，生产部署前请评估维护与支持要求。

文档处理链路为 MinIO 上传、Prisma 文档记录、BullMQ 入队、Worker 文本解析与分块、Embedding 计算、pgvector 批量写入，完成后将文档标记为 `READY`。处理失败会清除已写入的 chunks、记录错误并抛出异常，让 BullMQ 按退避策略重试；每次重试会先清理该文档已有 chunks，避免重复写入。

`npm test` 统一运行 Jest 测试。单元测试覆盖认证、请求校验、Workspace/Knowledge Base CRUD 与隔离、RAG 逻辑，以及文档处理与重试幂等性。另有一条完整验收测试会真实使用 PostgreSQL + pgvector、Redis/BullMQ 和 MinIO，执行注册、创建 Workspace/知识库、上传 Markdown、等待 Worker 完成、确认 1,536 维向量落库并发起 RAG 查询。请先启动 Compose 依赖（`docker compose up -d postgres redis minio`）并确保 `.env` 中数据库连接指向 `localhost`；测试会创建带随机名称的独立 PostgreSQL 数据库、执行实际迁移，结束后删除该测试库。验收测试使用本地假 LLM 服务，不会消耗外部 API key，并通过唯一 BullMQ 前缀隔离正在运行的应用队列。样例语料位于 `test/fixtures/rag-acceptance/`。

常用开发命令：`npm run build`、`npm run lint`、`npm run typecheck`、`npm test`。前端检查在 `frontend/` 下使用 `npm test` 与 `npm run build`；也可从根目录运行 `npm run frontend:test` 和 `npm run frontend:build`。
