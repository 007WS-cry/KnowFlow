# KnowFlow

KnowFlow 是面向团队与企业的多租户知识库 RAG 平台。团队可以在独立的 Workspace 中协作管理知识库与文档，通过自然语言查询资料，并查看回答引用的来源。

## 核心功能

- **团队协作与权限**：Workspace 成员、邀请和 OWNER / ADMIN / MEMBER 角色管理。
- **文档工作流**：浏览器直传 MinIO，支持大文件分片上传；后台处理任务显示阶段与进度，并支持重试、重新索引和取消。
- **混合检索与问答**：向量与关键词召回、融合和重排，支持流式追问及对话历史。
- **可追溯引用**：回答附带来源文档，并尽可能显示页码、标题路径等位置。

## 技术栈

- 前端：Vue 3、TypeScript、Element Plus、Vite
- 后端：Node.js 22、NestJS、Prisma
- 数据与任务：PostgreSQL + pgvector、Redis、BullMQ、MinIO
- AI：OpenAI-compatible 或本地 Embedding；独立 Reranker Provider；OpenAI-compatible LLM

## 快速启动

需要 Docker Compose、Node.js 22.12+ 和 npm 10+。

1. 创建配置文件：

   ```powershell
   Copy-Item .env.example .env
   ```

2. 编辑 `.env`，填写 Embedding、Reranker 和 LLM 服务的地址、模型与密钥。Embedding 用于文档索引和查询；Reranker 与 LLM 用于问答。使用 OpenAI-compatible 服务时，地址填写服务提供的 API 根地址。

3. 启动 API、数据库、Redis 和 MinIO：

   ```powershell
   docker compose up -d --build
   ```

4. 在另一个终端启动前端：

   ```powershell
   cd frontend
   npm install
   npm run dev
   ```

   打开 <http://localhost:3000>，注册账号并登录。API 会在启动时自动应用数据库迁移。

默认服务地址：

- KnowFlow：<http://localhost:3000>
- API：<http://localhost:8000/api/v1>
- API 文档：<http://localhost:8000/docs>

停止 Docker 服务：

```powershell
docker compose down
```

## 使用流程

1. 注册并登录，创建 Workspace 和知识库。
2. 在知识库页面上传 TXT、Markdown、PDF 或 DOCX 文件，等待处理状态变为“已就绪”。
3. 打开“知识问答”提问。回答会流式显示，并附上相关文档来源；可继续追问或查看历史对话。
4. 在“团队成员”中邀请同事加入 Workspace，并按职责分配角色。

Workspace 成员均可查看知识库、上传文档和提问。OWNER 与 ADMIN 可管理知识库；OWNER 负责 Workspace 与角色管理。MEMBER 只能删除自己上传的文档。

## 配置提示

- 文档由浏览器直接上传到 MinIO。默认单文件上限为 200 MB，超过 32 MB 使用分片上传。若从其他设备访问前端，请将 `.env` 中的 `MINIO_PUBLIC_ENDPOINT`、端口和协议设为浏览器可访问的 MinIO 地址，并允许前端来源通过 CORS 上传。
- 使用本地 Embedding 时，将 `EMBEDDING_PROVIDER` 设为 `local`，并配置模型目录；使用兼容服务时配置 `EMBEDDING_BASE_URL`、`EMBEDDING_MODEL` 和密钥。
- Reranker 需要提供兼容的 `/rerank` 接口；LLM 使用 OpenAI-compatible Chat Completions API。相关参数均在 `.env` 中配置。
