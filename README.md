# KnowFlow

KnowFlow 是面向团队与企业的多租户知识库 RAG 平台，提供 Vue + Element Plus 前端和 NestJS + TypeScript 后端，支持 Workspace 隔离、文档管理、混合检索、重排问答与来源引用。

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
# 在 .env 中配置 Embedding、Reranker 和 LLM 服务地址、模型及密钥
docker compose up -d --build
```

上传文档前需要配置 Embedding 服务；提问前还需要配置 Reranker 与 LLM。Embedding 默认使用 OpenAI-compatible `/embeddings` 接口，Reranker 使用独立的 `/rerank` 接口。服务地址可以指向云 API 或本机运行的推理服务；使用 Docker Compose 连接宿主机上的服务时，请使用 `host.docker.internal`，并确保服务监听可被容器访问的地址。

文档内容由浏览器通过 MinIO Presigned URL 直传，不经过 API 上传进程。默认单文件上限为 200 MB，32 MB 以上使用 Multipart Upload。Compose 默认将浏览器可访问的 MinIO 地址设为 `http://localhost:9000`，并允许 `CORS_ORIGIN` 指定的前端来源。前端不在本机时，请将 `.env` 中的 `MINIO_PUBLIC_ENDPOINT`、`MINIO_PUBLIC_PORT` 和 `MINIO_PUBLIC_USE_SSL` 设置为浏览器可访问的 MinIO 地址；反向代理、TLS 与 MinIO CORS 也必须允许前端来源及 PUT 请求。

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

然后在浏览器打开 <http://localhost:3000>，注册或登录即可使用。也可以直接从项目根目录执行 `npm run frontend:dev` 和 `npm run frontend:build`。非空知识库的文档处理需要可用的 Embedding Provider；问答还需要可用的 Reranker 和 LLM Provider。登录和知识库管理不依赖这些模型密钥。

### 修改源代码后重启

- 本地运行 API（`npm run start:dev`）：Nest watch 通常会自动重启；如未重启，在 API 终端按 `Ctrl+C` 后重新运行 `npm run start:dev`。
- API 运行在 Docker Compose 中：执行 `docker compose up -d --build api` 重建并启动 API 容器。
- 前端运行在 Vite 开发服务器中：通常会自动热更新；如已停止，在项目根目录运行 `npm run frontend:dev`，然后刷新浏览器。

仅修改 TypeScript 源码不需要重新生成 Prisma Client 或运行数据库迁移。只有修改 Prisma schema 或迁移文件时才需要执行相应的 Prisma 命令。

## Workspace 协作与权限

API 路径前缀为 `/api/v1`。除注册和登录外，业务请求需带上 `Authorization: Bearer <accessToken>`。Workspace 权限在后端统一检查；前端隐藏按钮只是界面引导，直接调用 API 也会执行相同的权限规则。

| 操作                                           | OWNER | ADMIN | MEMBER |
| ---------------------------------------------- | :---: | :---: | :----: |
| 查看 Workspace、成员、知识库、文档；查询和上传 |   ✓   |   ✓   |   ✓    |
| 创建、编辑、删除知识库；删除任意成员的文档     |   ✓   |   ✓   |   —    |
| 删除自己上传的文档                             |   ✓   |   ✓   |   ✓    |
| 邀请或移除 MEMBER；撤销 MEMBER 邀请            |   ✓   |   ✓   |   —    |
| 邀请 ADMIN、修改成员角色、移除 ADMIN           |   ✓   |   —   |   —    |
| 重命名或删除 Workspace                         |   ✓   |   —   |   —    |

新注册并创建 Workspace 的用户自动成为 OWNER。OWNER 可以将其他成员在 ADMIN 与 MEMBER 之间切换；系统不允许通过普通角色修改转让 OWNER。ADMIN 不能变更任何角色，也不能邀请、移除或撤销 ADMIN。成员不能通过成员管理移除自己或 OWNER。

### 在前端邀请团队成员

1. OWNER 或 ADMIN 登录后，在顶部点击“团队成员”。OWNER 可邀请 ADMIN 或 MEMBER；ADMIN 只能邀请 MEMBER。
2. 输入对方注册 KnowFlow 使用的邮箱和角色，创建邀请后复制页面显示的邀请链接。当前版本不发送邮件；邀请链接仅创建时显示。再次邀请同一邮箱会刷新凭证并使旧链接失效。
3. 接收者打开链接后注册或登录**与邀请邮箱一致**的账号。登录后页面会自动接受邀请并切换到加入的 Workspace。邀请有效期为 7 天且只能接受一次；如邮箱不一致，请退出并改用受邀邮箱登录。
4. “团队成员”窗口显示成员、角色和待处理邀请。OWNER 可以修改角色、移除 ADMIN 或 MEMBER；ADMIN 只能移除 MEMBER。OWNER 不能移除自己或删除自己的 OWNER 角色。

### 手动验证三种角色

建议用三个不同邮箱和独立浏览器会话操作；本地测试可打开普通窗口和无痕窗口，避免切换账号时混淆邀请链接与登录态。

1. 用 OWNER 账号创建 Workspace 和一个知识库，再从顶部“团队成员”分别邀请一个 ADMIN 和一个 MEMBER。将两条链接分别交给对应测试账号，注册/登录时使用完全相同的邮箱。
2. 用 MEMBER 登录：打开已有知识库，确认可以查看成员、上传文档和提问；上传后确认文档行显示自己是上传者，只有自己上传的文档可以勾选删除。确认知识库列表旁没有创建按钮、知识库页没有设置菜单，“团队成员”中没有邀请、角色修改和移除操作。
3. 用 ADMIN 登录：创建、编辑、删除知识库；上传并删除任意成员的文档；从“团队成员”邀请 MEMBER 和移除 MEMBER。确认不能邀请 ADMIN、修改角色、移除 ADMIN/OWNER，也不能重命名或删除 Workspace。
4. 用 OWNER 登录：在“团队成员”中将 MEMBER 提升为 ADMIN，使用该账号刷新后确认管理知识库的入口出现；再降回 MEMBER，确认入口消失。确认 OWNER 可以邀请 ADMIN、变更其他成员角色、移除 ADMIN/MEMBER、重命名 Workspace；不能移除自己。
5. 重新打开一条已使用的邀请链接应显示凭证已处理；用不同邮箱接受待处理邀请应失败。若链接丢失，OWNER/ADMIN 可在“团队成员”中对同一邮箱重新创建邀请并复制新链接，旧链接随之失效。

成员邀请相关 API：

- `GET /workspaces/{workspaceId}/members`：列出 Workspace 成员。所有成员均可查看。
- `POST /workspaces/{workspaceId}/invitations`：创建或刷新邀请，JSON 示例 `{"email":"teammate@example.com","role":"MEMBER"}`。OWNER 也可指定 `ADMIN`；省略 role 时默认为 MEMBER。
- `GET /workspaces/{workspaceId}/invitations`：查看待处理邀请，仅 OWNER/ADMIN 可用。
- `DELETE /workspaces/{workspaceId}/invitations/{invitationId}`：撤销邀请；ADMIN 仅能撤销 MEMBER 邀请。
- `POST /invitations/accept`：接受邀请，JSON 为 `{"token":"<邀请链接凭证>"}`，仅当前邮箱与邀请邮箱一致时成功。
- `PATCH /workspaces/{workspaceId}/members/{userId}`：修改为 `ADMIN` 或 `MEMBER`，仅 OWNER 可用。
- `DELETE /workspaces/{workspaceId}/members/{userId}`：移除成员，OWNER 可移除 ADMIN/MEMBER，ADMIN 仅可移除 MEMBER。

### 基本知识库操作

1. `POST /auth/register` 或 `POST /auth/login` 获取 access token；`GET /auth/me` 获取当前用户，`POST /auth/logout` 退出。
2. Workspace 支持 `POST /workspaces` 创建、`GET /workspaces` 列表、`GET /workspaces/{workspaceId}` 详情、`PATCH /workspaces/{workspaceId}` 更新和 `DELETE /workspaces/{workspaceId}` 删除。只有 OWNER 可以重命名或删除。
3. Knowledge Base 使用 `POST`、`GET /workspaces/{workspaceId}/knowledge-bases` 创建和列表；单项详情、更新、删除使用 `GET`、`PATCH`、`DELETE /knowledge-bases/{knowledgeBaseId}`。所有成员可查看；创建、编辑、删除仅 OWNER/ADMIN 可用。
4. `GET /knowledge-bases/{knowledgeBaseId}/documents` 查看文档。新建知识库默认返回空数组。
5. `POST /knowledge-bases/{knowledgeBaseId}/documents/uploads` 创建上传任务，JSON 为 `{"originalName":"handbook.pdf","sizeBytes":123456}`。响应提供单文件 Presigned URL，或 Multipart 参数。浏览器将文件直传 MinIO；分片上传时按需调用 `POST /documents/{documentId}/uploads/parts/url` 获取分片地址，最后调用 `POST /documents/{documentId}/uploads/complete` 启动索引。支持 TXT、Markdown、PDF、DOCX；默认最大 200 MB，可用 `MAX_UPLOAD_BYTES` 调整。文档列表和 `GET /documents/{documentId}` 返回任务阶段、百分比、失败原因与重试次数。上传链接 1 小时失效，未完成上传任务 24 小时后自动清理。
6. `POST /documents/{documentId}/retry` 重试失败任务；`POST /documents/{documentId}/reindex` 重新索引；`POST /documents/{documentId}/cancel` 取消上传或处理任务。文档处理按解析、结构化切块、Embedding、索引等阶段汇报状态。重索引先构建新 Chunk 版本，成功后切换；重建期间旧索引仍可用于问答。引用包含文件名、页码或标题路径等结构化位置信息。
7. `DELETE /knowledge-bases/{knowledgeBaseId}/documents` 按 ID 批量删除：`{"documentIds":["doc_id_1","doc_id_2"]}`。MEMBER 只能删除自己上传的文档；ADMIN/OWNER 可删除任意文档。这会同时删除 MinIO 对象、文档和 chunks，并递增知识库索引版本。
8. 普通查询仍可使用 `POST /query` 或 `POST /knowledge-bases/{knowledgeBaseId}/query`。持久化对话使用 `POST /conversations` 创建，`GET /knowledge-bases/{knowledgeBaseId}/conversations` 列表，`GET /conversations/{conversationId}/messages` 读取历史；`POST /conversations/{conversationId}/messages/stream` 以 SSE 流式发送追问，客户端断开会取消当前 LLM 请求，未完成回合不会写入历史。

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

文档原文件存入 MinIO，浏览器以 Presigned URL 直传，API 进程不缓冲文件内容。后台 Worker 解析 Markdown/TXT 标题与段落、PDF 页码、DOCX 标题和表格，再按约 1,200 字生成带有页码、标题路径、段落位置和表格行位置的 Chunk。Worker 默认并发为 1，可通过 `DOCUMENT_PROCESSING_CONCURRENCY` 调整；PDF/DOCX 解析会在 Worker 中读取文件，部署时应按文件上限配置足够内存。

提问时先检查 Workspace 访问权，再并行执行 pgvector 语义召回与 PostgreSQL 全文/trigram 关键词召回，经 RRF 融合和独立 Reranker 排序后，将 Top K 片段交给 LLM，并返回带文档位置的来源引用。空知识库会返回提示与空来源，不调用 LLM。`debug:true` 可查看两路召回、融合和重排结果。问答工作台使用 SSE 流式回答，并保存 Conversation/Message 历史以支持追问。

Redis 会缓存检索结果，默认有效期 5 分钟。缓存 key 包含 Workspace、Knowledge Base、索引版本、问题和模型/检索配置。每次文档索引成功切换或删除会递增 Knowledge Base 的 `indexVersion`，新查询自然进入新缓存版本；Redis 暂时不可用时会直接执行检索。

Embedding Provider 支持 OpenAI-compatible `/embeddings` 和本地 Transformers.js/ONNX 模型目录。模型名、版本和输出维度随 chunk 保存。切换 Embedding 模型或版本后，先重建全部向量：

```powershell
npm run embeddings:reindex
```

该命令会用当前 `.env` 配置重新嵌入已有 chunks；重建期间关键词检索仍可用。`EMBEDDING_PROVIDER=local` 时，将 `EMBEDDING_LOCAL_MODEL_PATH` 指向可由 Transformers.js 加载的本地模型目录，并将 `EMBEDDING_MODEL` 与 `EMBEDDING_VERSION` 设为对应模型标识和固定版本。模型若要求 query/document 不同前缀（例如 E5），可分别设置 `EMBEDDING_QUERY_PREFIX` 和 `EMBEDDING_DOCUMENT_PREFIX`；前缀会纳入流水线版本标识，修改后需运行上述命令重建已有向量。Compose 会将 `EMBEDDING_LOCAL_MODEL_HOST_PATH`（默认 `./models`）只读挂载到容器 `/models`。

若 API 运行在 Docker Compose 中，可在 API 容器内执行同一重建程序：

```powershell
docker compose exec api node dist/embeddings/reindex.js
```

Reranker 通过独立的 `RERANKER_BASE_URL`、`RERANKER_MODEL` 与 `RERANKER_API_KEY` 配置，不复用 LLM 接口。服务需提供 `POST /rerank`，接收 query、documents 和 top_n，并返回包含候选 index 与 relevance_score 的 results。`RERANKER_PROVIDER=disabled` 可用于临时跳过重排。LLM 使用 OpenAI-compatible Chat Completions API。不要把真实密钥提交到版本控制。

PostgreSQL 启用 `vector` 与 `pg_trgm` 扩展；向量与关键词查询使用参数化 SQL。Embedding 维度限制在 pgvector HNSW 支持的范围内。更换模型后若索引配置与已有向量不一致，查询会提示先执行全量重嵌入，避免混用不同模型的向量。

## 目录结构

```text
prisma/                   # Prisma schema 与 SQL migrations
src/
  auth/                   # 注册、登录、会话 guard
  config/                 # 环境变量校验
  documents/              # 上传、列表、删除、BullMQ 处理器
  embeddings/             # OpenAI-compatible / 本地 Embedding Provider 与重建命令
  health/                 # 健康检查
  knowledge-bases/        # 知识库 CRUD 与成员权限检查
  authorization/          # Workspace 角色矩阵与统一 Policy Guard
  cache/                  # Redis 检索结果缓存
  conversations/          # 对话、历史消息和 SSE 流式问答
  prisma/                 # Prisma client 生命周期
  queue/                  # BullMQ 队列
  rag/                    # 双路召回、RRF 融合、检索调试与 RAG 查询
  reranker/               # 独立 Reranker Provider
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

文档处理链路为创建上传任务、MinIO 单文件或 Multipart 直传、Complete 校验、BullMQ 入队、Worker 解析与结构化切块、Embedding 计算、pgvector 分批写入和版本切换。任务失败会保留失败原因；队列重试或手动 Retry 会写入新索引版本，旧活动版本在新版本提交前继续供查询。任务支持取消；未完成的 MinIO Multipart 会在取消或过期时清理。

`npm test` 统一运行 Jest 测试。单元测试覆盖直传上传任务、Multipart 校验、结构化 Chunk、任务阶段与重试、SSE 解析、Conversation 权限和 Redis 缓存 key。RAG 验收测试会使用 PostgreSQL + pgvector、Redis/BullMQ 和 MinIO，执行注册、创建 Workspace/知识库、经 Presigned URL 上传 Markdown、等待 Worker 完成、确认向量与索引版本落库，并执行混合检索、重排、对话流式问答和固定集指标评测。请先启动 Compose 依赖（`docker compose up -d postgres redis minio`）并确保 `.env` 中数据库连接指向 `localhost`；测试会创建带随机名称的独立 PostgreSQL 数据库、执行实际迁移，结束后删除该测试库。验收测试使用本地假 Embedding、Reranker 和 LLM 服务，不会消耗外部模型 API key，并通过唯一 BullMQ 前缀隔离正在运行的应用队列。样例语料位于 `test/fixtures/rag-acceptance/`。

固定评测集位于 `test/fixtures/rag-evaluation/questions.json`，包含 56 道问题及相关文档标注，覆盖现有三份示例语料。将这些 Markdown 文档上传到一个知识库后，设置有权访问该知识库的 ID 和 access token，再运行：

```powershell
$env:RAG_EVALUATION_KNOWLEDGE_BASE_ID = "your-knowledge-base-id"
$env:RAG_EVALUATION_ACCESS_TOKEN = "your-access-token"
npm run rag:evaluate
```

评测会调用当前配置的真实 RAG Provider，按文档级相关性记录 Recall@5、Recall@10、MRR 和 Citation Hit Rate，并将每题答案、来源和检索调试分数写入 `test/results/rag-evaluation-latest.json`。该结果文件默认不纳入版本控制，便于按模型版本重复运行和比较。

`test/reports/rag-acceptance-baseline.json` 记录了 56 道固定问题的验收输出、候选分数和指标。该基线由确定性假 Provider 生成，用于验证链路与评测记录格式，不代表真实模型的检索质量；真实模型基准请运行 `npm run rag:evaluate`。

常用开发命令：`npm run build`、`npm run lint`、`npm run typecheck`、`npm test`。前端检查在 `frontend/` 下使用 `npm test` 与 `npm run build`；也可从根目录运行 `npm run frontend:test` 和 `npm run frontend:build`。
