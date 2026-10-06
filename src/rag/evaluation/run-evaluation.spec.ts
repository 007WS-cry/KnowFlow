import { calculateMetrics } from './run-evaluation';

describe('RAG evaluation metrics', () => {
  it('computes Recall@K, MRR, and citation hit rate from fixed question results', () => {
    const metrics = calculateMetrics([
      {
        id: 'one',
        question: 'q1',
        relevantDocumentNames: ['a.md'],
        answer: 'A [1]',
        retrievedDocuments: ['a.md'],
        citedDocuments: ['a.md'],
        reciprocalRank: 1,
        recallAt5: 1,
        recallAt10: 1,
        candidates: [],
      },
      {
        id: 'two',
        question: 'q2',
        relevantDocumentNames: ['b.md'],
        answer: 'B [1]',
        retrievedDocuments: ['x.md', 'b.md'],
        citedDocuments: ['x.md'],
        reciprocalRank: 0.5,
        recallAt5: 1,
        recallAt10: 1,
        candidates: [],
      },
    ]);
    expect(metrics).toEqual({
      questionCount: 2,
      recallAt5: 1,
      recallAt10: 1,
      mrr: 0.75,
      citationHitRate: 0.5,
    });
  });
});
