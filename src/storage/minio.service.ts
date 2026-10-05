import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Minio from 'minio';

@Injectable()
export class MinioService implements OnModuleInit {
  private readonly logger = new Logger(MinioService.name);
  private readonly client: Minio.Client;
  private readonly bucket: string;

  constructor(config: ConfigService) {
    this.bucket = config.getOrThrow<string>('MINIO_BUCKET');
    const useSSL = config.get<string | boolean>('MINIO_USE_SSL');
    this.client = new Minio.Client({
      endPoint: config.getOrThrow<string>('MINIO_ENDPOINT'),
      port: Number(config.getOrThrow<string>('MINIO_PORT')),
      useSSL: useSSL === true || useSSL === 'true',
      accessKey: config.getOrThrow<string>('MINIO_ACCESS_KEY'),
      secretKey: config.getOrThrow<string>('MINIO_SECRET_KEY'),
    });
  }

  async onModuleInit(): Promise<void> {
    const attempts = 15;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        if (!(await this.client.bucketExists(this.bucket))) {
          await this.client.makeBucket(this.bucket, 'us-east-1');
        }
        this.logger.log(`MinIO bucket "${this.bucket}" is ready`);
        return;
      } catch (error) {
        if (attempt === attempts) {
          throw error;
        }

        this.logger.warn(`Waiting for MinIO (${attempt}/${attempts})`);
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  }

  getClient(): Minio.Client {
    return this.client;
  }

  getBucket(): string {
    return this.bucket;
  }
}
