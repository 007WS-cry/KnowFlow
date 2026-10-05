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
  MAX_UPLOAD_BYTES: Joi.number()
    .integer()
    .min(1024)
    .max(10 * 1024 * 1024)
    .default(10 * 1024 * 1024),

  LLM_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('https://api.openai.com/v1'),
  LLM_API_KEY: Joi.string().allow('').default(''),
  LLM_MODEL: Joi.string().min(1).default('gpt-4o-mini'),
});
