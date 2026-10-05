export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string | null;
}

export interface AuthenticatedRequest {
  headers: { authorization?: string };
  user?: AuthenticatedUser;
  sessionId?: string;
}
