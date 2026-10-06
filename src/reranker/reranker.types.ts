export interface RerankerDocument {
  id: string;
  content: string;
}

export interface RerankerResult {
  index: number;
  score: number;
}

export interface RerankerProvider {
  rerank(query: string, documents: RerankerDocument[]): Promise<RerankerResult[]>;
}

export const RERANKER_PROVIDER = Symbol('RERANKER_PROVIDER');
