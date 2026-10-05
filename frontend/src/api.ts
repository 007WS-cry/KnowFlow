import type {
  KnowledgeBase,
  KnowledgeDocument,
  RagResponse,
  SessionResponse,
  User,
  Workspace,
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
    | { message?: string | string[]; error?: string }
    | T
    | null;

  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'message' in payload
      ? payload.message
      : null;
    throw new Error(Array.isArray(message) ? message.join('；') : message || `请求失败（${response.status}）`);
  }
  return payload as T;
}

function jsonBody(body: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(body) };
}

export const api = {
  register: (email: string, password: string, name: string) =>
    request<SessionResponse>('/auth/register', jsonBody({ email, password, name })),
  login: (email: string, password: string) =>
    request<SessionResponse>('/auth/login', jsonBody({ email, password })),
  me: () => request<User>('/auth/me'),
  logout: () => request<{ success: true }>('/auth/logout', jsonBody({})),

  workspaces: () => request<Workspace[]>('/workspaces'),
  createWorkspace: (name: string) =>
    request<Workspace>('/workspaces', jsonBody({ name })),
  updateWorkspace: (id: string, name: string) =>
    request<Workspace>(`/workspaces/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  deleteWorkspace: (id: string) =>
    request<{ success: true; id: string }>(`/workspaces/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  knowledgeBases: (workspaceId: string) =>
    request<KnowledgeBase[]>(`/workspaces/${encodeURIComponent(workspaceId)}/knowledge-bases`),
  createKnowledgeBase: (workspaceId: string, name: string, description: string) =>
    request<KnowledgeBase>(
      `/workspaces/${encodeURIComponent(workspaceId)}/knowledge-bases`,
      { ...jsonBody({ name, description }) },
    ),
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
  uploadDocument: (knowledgeBaseId: string, file: File) => {
    const body = new FormData();
    body.append('file', file);
    return request<KnowledgeDocument & { jobId: string | null }>(
      `/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents`,
      { method: 'POST', body },
    );
  },
  deleteDocuments: (knowledgeBaseId: string, documentIds: string[]) =>
    request<{ deletedCount: number; deletedIds: string[] }>(
      `/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents`,
      { method: 'DELETE', body: JSON.stringify({ documentIds }) },
    ),

  ask: (knowledgeBaseId: string, question: string, topK = 5) =>
    request<RagResponse>('/query', jsonBody({ knowledgeBaseId, question, topK })),
};
