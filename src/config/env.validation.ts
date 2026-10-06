import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(8000),
  CORS_ORIGIN: Joi.string().default('http://localhost:3000'),

  DATABASE_URL: Joi.string().required(),

  REDIS_HOST: Joi.string().hostname().default('localhost'),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').default(''),
  REDIS_DB: Joi.number().integer().min(0).default(0),
  BULLMQ_PREFIX: Joi.string().min(1).default('bull'),

  MINIO_ENDPOINT: Joi.string().hostname().default('localhost'),
  MINIO_PORT: Joi.number().port().default(9000),
  MINIO_USE_SSL: Joi.boolean().default(false),
  MINIO_ACCESS_KEY: Joi.string().required(),
  MINIO_SECRET_KEY: Joi.string().required(),
  MINIO_BUCKET: Joi.string()
    .pattern(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
    .default('knowflow-documents'),
  MINIO_PUBLIC_ENDPOINT: Joi.string().hostname().default('localhost'),
  MINIO_PUBLIC_PORT: Joi.number().port().default(9000),
  MINIO_PUBLIC_USE_SSL: Joi.boolean().default(false),
  MAX_UPLOAD_BYTES: Joi.number()
    .integer()
    .min(1024)
    .max(2 * 1024 * 1024 * 1024)
    .default(200 * 1024 * 1024),
  UPLOAD_MULTIPART_THRESHOLD_BYTES: Joi.number()
    .integer()
    .min(5 * 1024 * 1024)
    .default(32 * 1024 * 1024),
  UPLOAD_PART_SIZE_BYTES: Joi.number()
    .integer()
    .min(5 * 1024 * 1024)
    .default(16 * 1024 * 1024),
  UPLOAD_URL_EXPIRY_SECONDS: Joi.number()
    .integer()
    .min(60)
    .max(7 * 24 * 60 * 60)
    .default(3600),
  DOCUMENT_PROCESSING_CONCURRENCY: Joi.number().integer().min(1).max(4).default(1),

  LLM_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('https://api.openai.com/v1'),
  LLM_API_KEY: Joi.string().allow('').default(''),
  LLM_MODEL: Joi.string().min(1).default('gpt-4o-mini'),

  EMBEDDING_PROVIDER: Joi.string().valid('openai-compatible', 'local').default('openai-compatible'),
  EMBEDDING_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('https://api.openai.com/v1'),
  EMBEDDING_API_KEY: Joi.string().allow('').default(''),
  EMBEDDING_MODEL: Joi.string().min(1).default('text-embedding-3-small'),
  EMBEDDING_VERSION: Joi.string().min(1).default('1'),
  EMBEDDING_QUERY_PREFIX: Joi.string().allow('').default(''),
  EMBEDDING_DOCUMENT_PREFIX: Joi.string().allow('').default(''),
  EMBEDDING_DIMENSIONS: Joi.number().integer().min(1).max(2000).allow('').optional(),
  EMBEDDING_LOCAL_MODEL_PATH: Joi.when('EMBEDDING_PROVIDER', {
    is: 'local',
    then: Joi.string().min(1).required(),
    otherwise: Joi.string().allow('').default(''),
  }),

  RERANKER_PROVIDER: Joi.string().valid('compatible', 'disabled').default('compatible'),
  RERANKER_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:8001/v1'),
  RERANKER_API_KEY: Joi.string().allow('').default(''),
  RERANKER_MODEL: Joi.string().min(1).default('BAAI/bge-reranker-v2-m3'),
  RAG_RECALL_CANDIDATE_LIMIT: Joi.number().integer().min(10).max(200).default(50),
  RAG_RERANK_CANDIDATE_LIMIT: Joi.number().integer().min(10).max(200).default(50),
  RAG_RETRIEVAL_CACHE_TTL_SECONDS: Joi.number().integer().min(0).max(86400).default(300),
});
