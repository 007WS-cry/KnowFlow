import { ConfigService } from '@nestjs/config';
import { OpenAiCompatibleEmbeddingProvider } from './openai-compatible-embedding.provider';

describe('OpenAiCompatibleEmbeddingProvider', () => {
  const config = {
    getOrThrow: (key: string) =>
      ({
        EMBEDDING_BASE_URL: 'http://embedding.test/v1/',
        EMBEDDING_MODEL: 'embed-model',
      })[key],
    get: (key: string, fallback?: string) =>
      ({ EMBEDDING_API_KEY: 'test-key', EMBEDDING_VERSION: 'weights-v2', EMBEDDING_DIMENSIONS: 2 })[
        key
      ] ?? fallback,
  } as unknown as ConfigService;

  afterEach(() => jest.restoreAllMocks());

  it('sends batch inputs and returns vectors in input order with the configured profile', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: [0, 1] },
            { index: 0, embedding: [1, 0] },
          ],
        }),
        { status: 200 },
      ),
    );
    const provider = new OpenAiCompatibleEmbeddingProvider(config);

    await expect(provider.embedMany(['first', 'second'])).resolves.toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(provider.providerName).toBe('openai-compatible');
    expect(provider.model).toBe('embed-model');
    expect(provider.version).toBe('weights-v2');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://embedding.test/v1/embeddings',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
        body: JSON.stringify({ model: 'embed-model', input: ['first', 'second'], dimensions: 2 }),
      }),
    );
  });

  it('rejects vectors whose dimensions differ from the configured dimension', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 1] }] }), {
        status: 200,
      }),
    );
    const provider = new OpenAiCompatibleEmbeddingProvider(config);
    await expect(provider.embedMany(['query'])).rejects.toThrow('向量维度不匹配');
  });
});
