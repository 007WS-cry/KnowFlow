import { ConfigService } from '@nestjs/config';
import { HttpRerankerProvider } from './http-reranker.provider';

describe('HttpRerankerProvider', () => {
  const config = {
    getOrThrow: (key: string) =>
      ({ RERANKER_BASE_URL: 'http://reranker.test/v1', RERANKER_MODEL: 'rerank-model' })[key],
    get: (key: string) => ({ RERANKER_API_KEY: 'test-key' })[key],
  } as unknown as ConfigService;

  afterEach(() => jest.restoreAllMocks());

  it('calls the independent rerank endpoint and returns score-index pairs', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: [
            { index: 1, relevance_score: 0.98 },
            { index: 0, relevance_score: 0.2 },
          ],
        }),
        { status: 200 },
      ),
    );
    const provider = new HttpRerankerProvider(config);
    await expect(
      provider.rerank('question', [
        { id: 'one', content: 'first' },
        { id: 'two', content: 'second' },
      ]),
    ).resolves.toEqual([
      { index: 1, score: 0.98 },
      { index: 0, score: 0.2 },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://reranker.test/v1/rerank',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
        body: JSON.stringify({
          model: 'rerank-model',
          query: 'question',
          documents: ['first', 'second'],
          top_n: 2,
        }),
      }),
    );
  });
});
