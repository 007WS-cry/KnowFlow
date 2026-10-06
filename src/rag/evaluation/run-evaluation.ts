import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface EvaluationQuestion {
  id: string;
  question: string;
  relevantDocumentNames: string[];
}

export interface QueryResponse {
  answer: string;
  sources: Array<{ citation: number; documentName: string }>;
  retrievalDebug: {
    embeddingProfile: { provider: string; model: string; version: string; dimension: number };
    candidates: Array<{
      documentName: string;
      vectorRank: number | null;
      keywordRank: number | null;
      fusionScore: number;
      rerankScore: number | null;
    }>;
  };
}

export interface QuestionResult {
  id: string;
  question: string;
  relevantDocumentNames: string[];
  answer: string;
  retrievedDocuments: string[];
  citedDocuments: string[];
  reciprocalRank: number;
  recallAt5: number;
  recallAt10: number;
  candidates: QueryResponse['retrievalDebug']['candidates'];
}

export function calculateMetrics(results: QuestionResult[]) {
  const count = Math.max(results.length, 1);
  const citationHits = results.filter((result) => {
    const relevantDocuments = new Set(uniqueDocumentNames(result.relevantDocumentNames));
    return result.citedDocuments.some((document) =>
      relevantDocuments.has(document.toLocaleLowerCase()),
    );
  }).length;
  return {
    questionCount: results.length,
    recallAt5: results.reduce((sum, result) => sum + result.recallAt5, 0) / count,
    recallAt10: results.reduce((sum, result) => sum + result.recallAt10, 0) / count,
    mrr: results.reduce((sum, result) => sum + result.reciprocalRank, 0) / count,
    citationHitRate: citationHits / count,
  };
}

function uniqueDocumentNames(names: string[]): string[] {
  return [...new Set(names.map((name) => name.toLocaleLowerCase()))];
}

export function evaluateQuestionResult(
  item: EvaluationQuestion,
  result: QueryResponse,
): QuestionResult {
  const candidates = [...(result.retrievalDebug?.candidates ?? [])].sort(
    (left, right) => (right.rerankScore ?? -Infinity) - (left.rerankScore ?? -Infinity),
  );
  const rankedNames = candidates.map(({ documentName }) => documentName);
  const gold = uniqueDocumentNames(item.relevantDocumentNames);
  const retrieved = (limit: number) => uniqueDocumentNames(rankedNames.slice(0, limit));
  const citedNumbers = [...result.answer.matchAll(/\[(\d+)\]/gu)].map((match) => Number(match[1]));
  const citedDocuments = result.sources
    .filter((source) => citedNumbers.includes(source.citation))
    .map(({ documentName }) => documentName);
  const firstRelevantRank = candidates.findIndex(({ documentName }) =>
    gold.includes(documentName.toLocaleLowerCase()),
  );
  return {
    id: item.id,
    question: item.question,
    relevantDocumentNames: item.relevantDocumentNames,
    answer: result.answer,
    retrievedDocuments: rankedNames.slice(0, 10),
    citedDocuments,
    reciprocalRank: firstRelevantRank < 0 ? 0 : 1 / (firstRelevantRank + 1),
    recallAt5:
      gold.length === 0
        ? 0
        : gold.filter((name) => retrieved(5).includes(name)).length / gold.length,
    recallAt10:
      gold.length === 0
        ? 0
        : gold.filter((name) => retrieved(10).includes(name)).length / gold.length,
    candidates: result.retrievalDebug?.candidates ?? [],
  };
}

async function run(): Promise<void> {
  const baseUrl = (process.env.RAG_EVALUATION_API_URL ?? 'http://localhost:8000').replace(
    /\/+$/,
    '',
  );
  const knowledgeBaseId = process.env.RAG_EVALUATION_KNOWLEDGE_BASE_ID;
  const accessToken = process.env.RAG_EVALUATION_ACCESS_TOKEN;
  if (!knowledgeBaseId || !accessToken) {
    throw new Error(
      '请设置 RAG_EVALUATION_KNOWLEDGE_BASE_ID 和 RAG_EVALUATION_ACCESS_TOKEN，再运行评测',
    );
  }

  const questionsPath = resolve(process.cwd(), 'test/fixtures/rag-evaluation/questions.json');
  const questions = JSON.parse(readFileSync(questionsPath, 'utf8')) as EvaluationQuestion[];
  const output: QuestionResult[] = [];
  let embeddingProfile: QueryResponse['retrievalDebug']['embeddingProfile'] | undefined;

  for (const item of questions) {
    const response = await fetch(
      `${baseUrl}/api/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ question: item.question, topK: 10, debug: true }),
        signal: AbortSignal.timeout(90_000),
      },
    );
    if (!response.ok) throw new Error(`评测问题 ${item.id} 返回 HTTP ${response.status}`);
    const result = (await response.json()) as QueryResponse;
    embeddingProfile ??= result.retrievalDebug?.embeddingProfile;
    output.push(evaluateQuestionResult(item, result));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    knowledgeBaseId,
    embeddingProfile: embeddingProfile ?? null,
    metrics: calculateMetrics(output),
    results: output,
  };
  const outputPath = resolve(
    process.cwd(),
    process.env.RAG_EVALUATION_OUTPUT ?? 'test/results/rag-evaluation-latest.json',
  );
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ outputPath, metrics: report.metrics }, null, 2)}\n`);
}

if (require.main === module) {
  void run().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'RAG evaluation failed'}\n`);
    process.exitCode = 1;
  });
}
