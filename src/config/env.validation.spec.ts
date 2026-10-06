import { envValidationSchema } from './env.validation';

const requiredConfiguration = {
  DATABASE_URL: 'postgresql://knowflow:password@localhost:5432/knowflow',
  MINIO_ACCESS_KEY: 'minio-user',
  MINIO_SECRET_KEY: 'minio-secret',
};

describe('environment validation for model providers', () => {
  it('accepts an empty embedding dimension when the selected model reports its native size', () => {
    const { error } = envValidationSchema.validate({
      ...requiredConfiguration,
      EMBEDDING_DIMENSIONS: '',
    });
    expect(error).toBeUndefined();
  });

  it('requires a local model directory when local embeddings are selected', () => {
    const { error } = envValidationSchema.validate({
      ...requiredConfiguration,
      EMBEDDING_PROVIDER: 'local',
      EMBEDDING_LOCAL_MODEL_PATH: '',
    });
    expect(error?.message).toContain('EMBEDDING_LOCAL_MODEL_PATH');
  });
});
