import type {
  KnowledgeBase,
  KnowledgeDocument,
  AcceptedWorkspaceInvitation,
  RagResponse,
  SessionResponse,
  User,
  WorkspaceInvitation,
  WorkspaceInvitationResponse,
  WorkspaceMember,
  Workspace,
  WorkspaceRole,
  UploadStartResponse,
  ConversationSummary,
  ConversationMessage,
} from './types';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api/v1';
const TOKEN_KEY = 'knowflow.accessToken';

export function getAccessToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setAccessToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAccessToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return '请求失败，请稍后重试';
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch {
    throw new Error('无法连接 KnowFlow API。请先启动后端服务，再刷新页面。');
  }

  if (response.status === 204) return undefined as T;
  const payload = (await response.json().catch(() => null)) as
    { message?: string | string[]; error?: string } | T | null;

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'message' in payload ? payload.message : null;
    throw new Error(
      Array.isArray(message) ? message.join('；') : message || `请求失败（${response.status}）`,
    );
  }
  return payload as T;
}

function jsonBody(body: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(body) };
}

function directUpload(url: string, body: Blob, onProgress: (loaded: number) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => signal?.removeEventListener('abort', abort);
    xhr.open('PUT', url);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    };
    xhr.onerror = () => {
      cleanup();
      reject(new Error('无法连接 MinIO，请检查公开地址及 CORS 配置'));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException('上传已取消', 'AbortError'));
    };
    xhr.onload = () => {
      cleanup();
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`MinIO 上传失败（${xhr.status}）`));
        return;
      }
      resolve();
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    xhr.send(body);
  });
}

export const api = {
  register: (email: string, password: string, name: string) =>
    request<SessionResponse>('/auth/register', jsonBody({ email, password, name })),
  login: (email: string, password: string) =>
    request<SessionResponse>('/auth/login', jsonBody({ email, password })),
  me: () => request<User>('/auth/me'),
  logout: () => request<{ success: true }>('/auth/logout', jsonBody({})),

  workspaces: () => request<Workspace[]>('/workspaces'),
  createWorkspace: (name: string) => request<Workspace>('/workspaces', jsonBody({ name })),
  updateWorkspace: (id: string, name: string) =>
    request<Workspace>(`/workspaces/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  deleteWorkspace: (id: string) =>
    request<{ success: true; id: string }>(`/workspaces/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  workspaceMembers: (id: string) =>
    request<WorkspaceMember[]>(`/workspaces/${encodeURIComponent(id)}/members`),
  workspaceInvitations: (id: string) =>
    request<WorkspaceInvitation[]>(`/workspaces/${encodeURIComponent(id)}/invitations`),
  inviteWorkspaceMember: (
    id: string,
    email: string,
    role: Exclude<WorkspaceRole, 'OWNER'> = 'MEMBER',
  ) =>
    request<WorkspaceInvitationResponse>(
      `/workspaces/${encodeURIComponent(id)}/invitations`,
      jsonBody({ email, role }),
    ),
  acceptWorkspaceInvitation: (token: string) =>
    request<AcceptedWorkspaceInvitation>('/invitations/accept', jsonBody({ token })),
  revokeWorkspaceInvitation: (workspaceId: string, invitationId: string) =>
    request<{ success: true; id: string }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/invitations/${encodeURIComponent(invitationId)}`,
      { method: 'DELETE' },
    ),
  removeWorkspaceMember: (workspaceId: string, userId: string) =>
    request<{ success: true; userId: string }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    ),
  updateWorkspaceMemberRole: (
    workspaceId: string,
    userId: string,
    role: Exclude<WorkspaceRole, 'OWNER'>,
  ) =>
    request<WorkspaceMember>(
      `/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
      { method: 'PATCH', body: JSON.stringify({ role }) },
    ),

  knowledgeBases: (workspaceId: string) =>
    request<KnowledgeBase[]>(`/workspaces/${encodeURIComponent(workspaceId)}/knowledge-bases`),
  createKnowledgeBase: (workspaceId: string, name: string, description: string) =>
    request<KnowledgeBase>(`/workspaces/${encodeURIComponent(workspaceId)}/knowledge-bases`, {
      ...jsonBody({ name, description }),
    }),
  updateKnowledgeBase: (id: string, name: string, description: string) =>
    request<KnowledgeBase>(`/knowledge-bases/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name, description }),
    }),
  deleteKnowledgeBase: (id: string) =>
    request<{ success: true; id: string }>(`/knowledge-bases/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  documents: (knowledgeBaseId: string) =>
    request<KnowledgeDocument[]>(
      `/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents`,
    ),
  uploadDocument: async (
    knowledgeBaseId: string,
    file: File,
    onTaskCreated: (document: KnowledgeDocument) => void = () => undefined,
    onProgress: (percent: number) => void = () => undefined,
    signal?: AbortSignal,
  ) => {
    const started = await request<UploadStartResponse>(
      `/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/uploads`,
      jsonBody({ originalName: file.name, sizeBytes: file.size }),
    );
    onTaskCreated(started.document);
    if (started.uploadMode === 'single') {
      await directUpload(started.uploadUrl!, file, (loaded) => onProgress(Math.round((loaded / file.size) * 100)), signal);
      return request<KnowledgeDocument & { jobId: string | null }>(
        `/documents/${encodeURIComponent(started.document.id)}/uploads/complete`,
        jsonBody({}),
      );
    }

    const partSize = started.partSizeBytes!;
    const partCount = started.partCount!;
    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      if (signal?.aborted) throw new DOMException('上传已取消', 'AbortError');
      const { uploadUrl } = await request<{ uploadUrl: string }>(
        `/documents/${encodeURIComponent(started.document.id)}/uploads/parts/url`,
        jsonBody({ partNumber }),
      );
      const start = (partNumber - 1) * partSize;
      const end = Math.min(start + partSize, file.size);
      await directUpload(
        uploadUrl,
        file.slice(start, end),
        (loaded) => onProgress(Math.round(((start + loaded) / file.size) * 100)),
        signal,
      );
    }
    return request<KnowledgeDocument & { jobId: string | null }>(
      `/documents/${encodeURIComponent(started.document.id)}/uploads/complete`,
      jsonBody({}),
    );
  },
  retryDocument: (documentId: string) =>
    request<KnowledgeDocument>(`/documents/${encodeURIComponent(documentId)}/retry`, jsonBody({})),
  reindexDocument: (documentId: string) =>
    request<KnowledgeDocument>(`/documents/${encodeURIComponent(documentId)}/reindex`, jsonBody({})),
  cancelDocument: (documentId: string) =>
    request<{ documentId: string; cancellationRequested: boolean; status: string }>(
      `/documents/${encodeURIComponent(documentId)}/cancel`,
      jsonBody({}),
    ),
  deleteDocuments: (knowledgeBaseId: string, documentIds: string[]) =>
    request<{ deletedCount: number; deletedIds: string[] }>(
      `/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents`,
      { method: 'DELETE', body: JSON.stringify({ documentIds }) },
    ),

  ask: (knowledgeBaseId: string, question: string, topK = 5) =>
    request<RagResponse>('/query', jsonBody({ knowledgeBaseId, question, topK })),
  createConversation: (knowledgeBaseId: string, title: string) =>
    request<ConversationSummary>('/conversations', jsonBody({ knowledgeBaseId, title })),
  conversations: (knowledgeBaseId: string) =>
    request<ConversationSummary[]>(`/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/conversations`),
  conversationMessages: (conversationId: string) =>
    request<ConversationMessage[]>(`/conversations/${encodeURIComponent(conversationId)}/messages`),
};

export async function streamConversationMessage(
  conversationId: string,
  question: string,
  signal: AbortSignal,
  onEvent: (event: { type: string; data: unknown }) => void,
): Promise<void> {
  const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'text/event-stream' });
  const token = getAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(
    `${API_BASE}/conversations/${encodeURIComponent(conversationId)}/messages/stream`,
    { method: 'POST', headers, body: JSON.stringify({ question }), signal },
  );
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => null) as { message?: string | string[] } | null;
    throw new Error(Array.isArray(payload?.message) ? payload.message.join('；') : payload?.message || `请求失败（${response.status}）`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';
    for (const raw of events) {
      const event = raw.split('\n').reduce((result, line) => {
        if (line.startsWith('event:')) result.type = line.slice(6).trim();
        if (line.startsWith('data:')) result.data += line.slice(5).trim();
        return result;
      }, { type: 'message', data: '' });
      if (event.data) onEvent({ type: event.type, data: JSON.parse(event.data) as unknown });
    }
  }
}
