import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, clearAccessToken, setAccessToken, streamConversationMessage } from './api';

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('frontend API client', () => {
  beforeEach(() => {
    clearAccessToken();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the session token and JSON body for authenticated actions', async () => {
    setAccessToken('session-token');
    fetchMock.mockResolvedValue(jsonResponse(200, [{ id: 'kb-1', name: 'Personal' }]));

    await api.knowledgeBases('workspace-1');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/workspaces/workspace-1/knowledge-bases');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer session-token');
  });

  it('creates an upload task, sends file bytes directly to MinIO, then completes the task', async () => {
    setAccessToken('session-token');
    fetchMock
      .mockResolvedValueOnce(jsonResponse(201, {
        document: { id: 'doc-1', originalName: 'guide.md' },
        uploadMode: 'single',
        uploadUrl: 'https://minio.test/signed-put',
      }))
      .mockResolvedValueOnce(jsonResponse(201, { id: 'doc-1', originalName: 'guide.md', jobId: 'job-1' }));
    const xhrCalls: Array<{ url: string; body: Blob }> = [];
    class FakeXhr {
      upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
      status = 200;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      onload: (() => void) | null = null;
      private url = '';
      open(_method: string, url: string) { this.url = url; }
      send(body: Blob) {
        xhrCalls.push({ url: this.url, body });
        this.upload.onprogress?.({ lengthComputable: true, loaded: body.size } as ProgressEvent);
        queueMicrotask(() => this.onload?.());
      }
      abort() { this.onabort?.(); }
      getResponseHeader(name: string) { return name.toLowerCase() === 'etag' ? '"part-etag"' : null; }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const onTaskCreated = vi.fn();
    const onProgress = vi.fn();
    const result = await api.uploadDocument(
      'kb-1',
      new File(['guide'], 'guide.md', { type: 'text/markdown' }),
      onTaskCreated,
      onProgress,
    );

    expect(result).toMatchObject({ id: 'doc-1', jobId: 'job-1' });
    expect(xhrCalls).toHaveLength(1);
    expect(xhrCalls[0]!.url).toBe('https://minio.test/signed-put');
    expect(xhrCalls[0]!.body).toBeInstanceOf(File);
    expect(onTaskCreated).toHaveBeenCalledWith({ id: 'doc-1', originalName: 'guide.md' });
    expect(onProgress).toHaveBeenCalledWith(100);
    const [createUrl, createInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(createUrl).toBe('/api/v1/knowledge-bases/kb-1/documents/uploads');
    expect(JSON.parse(createInit.body as string)).toEqual({ originalName: 'guide.md', sizeBytes: 5 });
    expect(new Headers(createInit.headers).get('Authorization')).toBe('Bearer session-token');
    expect((fetchMock.mock.calls[1]![0] as string)).toBe('/api/v1/documents/doc-1/uploads/complete');
  });

  it('uses persistent conversations and streamed messages endpoints', async () => {
    setAccessToken('session-token');
    fetchMock.mockResolvedValue(jsonResponse(200, []));
    await api.createConversation('kb-1', 'Question');
    await api.conversations('kb-1');
    await api.conversationMessages('conversation-1');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/conversations',
      '/api/v1/knowledge-bases/kb-1/conversations',
      '/api/v1/conversations/conversation-1/messages',
    ]);
  });

  it('parses streamed answer events and forwards the abort signal', async () => {
    setAccessToken('session-token');
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: delta\ndata: {"text":"第一段"}\n\nevent: complete\ndata: {"answer":"第一段"}\n\n'));
        controller.close();
      },
    });
    fetchMock.mockResolvedValue({ ok: true, status: 200, body } as Response);
    const abortController = new AbortController();
    const onEvent = vi.fn();

    await streamConversationMessage('conversation-1', '问题', abortController.signal, onEvent);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/conversations/conversation-1/messages/stream',
      expect.objectContaining({ signal: abortController.signal }),
    );
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: 'delta', data: { text: '第一段' } },
      { type: 'complete', data: { answer: '第一段' } },
    ]);
  });

  it('uses the workspace collaboration endpoints for invites, acceptance, and role changes', async () => {
    setAccessToken('session-token');
    fetchMock.mockResolvedValue(jsonResponse(200, {}));

    await api.inviteWorkspaceMember('team/one', 'new@example.com', 'ADMIN');
    await api.acceptWorkspaceInvitation('opaque-token');
    await api.updateWorkspaceMemberRole('team/one', 'user/one', 'MEMBER');
    await api.removeWorkspaceMember('team/one', 'user/one');

    expect(fetchMock.mock.calls.map(([url, init]) => [url, (init as RequestInit).method])).toEqual([
      ['/api/v1/workspaces/team%2Fone/invitations', 'POST'],
      ['/api/v1/invitations/accept', 'POST'],
      ['/api/v1/workspaces/team%2Fone/members/user%2Fone', 'PATCH'],
      ['/api/v1/workspaces/team%2Fone/members/user%2Fone', 'DELETE'],
    ]);
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).toEqual({
      email: 'new@example.com',
      role: 'ADMIN',
    });
  });

  it('joins backend validation errors into a readable message', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, { message: ['邮箱格式无效', '密码至少需要 8 位'], statusCode: 400 }),
    );

    await expect(api.login('bad-email', 'x')).rejects.toThrow('邮箱格式无效；密码至少需要 8 位');
  });
});
