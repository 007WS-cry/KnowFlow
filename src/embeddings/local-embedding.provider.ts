import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmbeddingProvider } from './embedding.types';

interface FeatureExtractionPipeline {
  (
    text: string,
    options: { pooling: 'mean'; normalize: true },
  ): Promise<{
    data: ArrayLike<number>;
    dims: number[];
  }>;
}

interface TransformersModule {
  pipeline(
    task: 'feature-extraction',
    model: string,
    options: { local_files_only: true },
  ): Promise<FeatureExtractionPipeline>;
}

@Injectable()
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly providerName = 'local';
  readonly model: string;
  readonly version: string;
  private readonly modelPath: string;
  private readonly configuredDimensions?: number;
  private pipelinePromise?: Promise<FeatureExtractionPipeline>;

  constructor(config: ConfigService) {
    this.modelPath = config.get<string>('EMBEDDING_LOCAL_MODEL_PATH', '').trim();
    this.model = config.get<string>('EMBEDDING_MODEL', this.modelPath || 'local-model');
    this.version = config.get<string>('EMBEDDING_VERSION', 'local-1');
    const dimensions = config.get<string | number>('EMBEDDING_DIMENSIONS');
    if (dimensions !== undefined && `${dimensions}`.trim()) {
      this.configuredDimensions = Number(dimensions);
    }
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    const pipeline = await this.loadPipeline();
    const vectors = await Promise.all(
      texts.map(async (text) => {
        const output = await pipeline(text, { pooling: 'mean', normalize: true });
        return Array.from(output.data);
      }),
    );
    const dimension = vectors[0]?.length;
    if (
      !dimension ||
      dimension > 2000 ||
      vectors.some(
        (vector) => vector.length !== dimension || vector.some((value) => !Number.isFinite(value)),
      ) ||
      (this.configuredDimensions !== undefined && dimension !== this.configuredDimensions)
    ) {
      throw new ServiceUnavailableException('本地 Embedding 模型返回的向量维度不匹配');
    }
    return vectors;
  }

  private loadPipeline(): Promise<FeatureExtractionPipeline> {
    this.pipelinePromise ??= this.createPipeline();
    return this.pipelinePromise;
  }

  private async createPipeline(): Promise<FeatureExtractionPipeline> {
    try {
      if (!this.modelPath) throw new Error('EMBEDDING_LOCAL_MODEL_PATH is required');
      // Keep this dynamic so the Nest CommonJS build can load the ESM runtime.
      const dynamicImport = new Function('specifier', 'return import(specifier)') as (
        specifier: string,
      ) => Promise<TransformersModule>;
      const transformers = await dynamicImport('@huggingface/transformers');
      return await transformers.pipeline('feature-extraction', this.modelPath, {
        local_files_only: true,
      });
    } catch {
      this.pipelinePromise = undefined;
      throw new ServiceUnavailableException(
        '无法加载本地 Embedding 模型，请检查 EMBEDDING_LOCAL_MODEL_PATH 和模型文件',
      );
    }
  }
}
