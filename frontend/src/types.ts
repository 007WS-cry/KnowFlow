export interface User {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
}

export interface SessionResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresAt: string;
  user: User;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  createdAt: string;
}

export type WorkspaceRole = 'OWNER' | 'ADMIN' | 'MEMBER';

export interface WorkspaceMember {
  userId: string;
  email: string;
  name: string | null;
  role: WorkspaceRole;
  joinedAt: string;
}

export interface WorkspaceInvitation {
  id: string;
  email: string;
  role: Exclude<WorkspaceRole, 'OWNER'>;
  status: 'PENDING';
  expiresAt: string;
  createdAt: string;
  invitedBy: { name: string | null; email: string } | null;
}

export interface WorkspaceInvitationResponse {
  email: string;
  role: Exclude<WorkspaceRole, 'OWNER'>;
  invitationToken: string;
  expiresAt: string;
}

export interface AcceptedWorkspaceInvitation {
  workspace: { id: string; name: string };
  role: WorkspaceRole;
}

export interface KnowledgeBase {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  _count: { documents: number };
}

export type DocumentStatus = 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';

export interface KnowledgeDocument {
  id: string;
  uploadedByUserId: string | null;
  uploadedByUser: { name: string | null; email: string } | null;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  status: DocumentStatus;
  errorMessage: string | null;
  processedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RetrievedChunk {
  id: string;
  documentId: string;
  documentName: string;
  chunkIndex: number;
  content: string;
  score: number;
}

export interface RagResponse {
  knowledgeBaseId: string;
  question: string;
  answerMode: 'empty' | 'llm';
  answer: string;
  chunks: RetrievedChunk[];
  sources: Array<{
    citation: number;
    documentId: string;
    documentName: string;
    chunkIndex: number;
    score: number;
  }>;
  citations: RagResponse['sources'];
}
