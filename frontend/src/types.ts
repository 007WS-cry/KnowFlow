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
