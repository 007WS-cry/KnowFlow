import { ConfigService } from '@nestjs/config';
import { EmbeddingProvider } from './embedding.types';
import { EmbeddingService } from './embedding.service';

describe('EmbeddingService', () => {
  it('applies query and document prefixes and includes them in the pipeline version', async () => {
    const provider: EmbeddingProvider = {
      providerName: 'local',
      model: 'e5-small',
      version: 'weights-v1',
      embedMany: jest.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
    };
    const config = {
      get: (key: string, fallback?: string) =>
        ({ EMBEDDING_QUERY_PREFIX: 'query: ', EMBEDDING_DOCUMENT_PREFIX: 'passage: ' })[key] ??
        fallback,
    } as unknown as ConfigService;
    const service = new EmbeddingService(provider, config);

    await expect(service.embedQuery('where is Paris?')).resolves.toEqual([0.1, 0.2]);
    await expect(service.embedDocuments(['Paris is in France.'])).resolves.toEqual([[0.1, 0.2]]);
    expect(provider.embedMany).toHaveBeenNthCalledWith(1, ['query: where is Paris?']);
    expect(provider.embedMany).toHaveBeenNthCalledWith(2, ['passage: Paris is in France.']);
    expect(service.getProfile(2)).toEqual({
      provider: 'local',
      model: 'e5-small',
      version: 'weights-v1;q=query%3A%20;d=passage%3A%20',
      dimension: 2,
    });
  });
});
