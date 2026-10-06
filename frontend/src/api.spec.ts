import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, clearAccessToken, setAccessToken } from './api';

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

  it('preserves multipart boundaries when uploading documents', async () => {
    setAccessToken('session-token');
    fetchMock.mockResolvedValue(jsonResponse(201, { id: 'doc-1', originalName: 'guide.md' }));

    await api.uploadDocument('kb-1', new File(['guide'], 'guide.md', { type: 'text/markdown' }));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeInstanceOf(FormData);
    expect(new Headers(init.headers).get('Content-Type')).toBeNull();
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer session-token');
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
