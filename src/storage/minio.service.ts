import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Minio from 'minio';

@Injectable()
export class MinioService implements OnModuleInit {
  private readonly logger = new Logger(MinioService.name);
  private readonly client: Minio.Client;
  private readonly signingClient: Minio.Client;
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
    const publicUseSSL = config.get<string | boolean>('MINIO_PUBLIC_USE_SSL', useSSL ?? false);
    this.signingClient = new Minio.Client({
      endPoint: config.get<string>(
        'MINIO_PUBLIC_ENDPOINT',
        config.getOrThrow<string>('MINIO_ENDPOINT'),
      ),
      port: Number(
        config.get<string>('MINIO_PUBLIC_PORT', config.getOrThrow<string>('MINIO_PORT')),
      ),
      useSSL: publicUseSSL === true || publicUseSSL === 'true',
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

  signSingleUpload(objectKey: string, expiresSeconds: number): Promise<string> {
    return this.signingClient.presignedPutObject(this.bucket, objectKey, expiresSeconds);
  }

  signMultipartPart(objectKey: string, uploadId: string, partNumber: number): Promise<string> {
    return this.signingClient.presignedUrl('PUT', this.bucket, objectKey, 900, {
      uploadId,
      partNumber: String(partNumber),
    });
  }

  initiateMultipart(objectKey: string, mimeType: string): Promise<string> {
    return this.client.initiateNewMultipartUpload(this.bucket, objectKey, {
      'Content-Type': mimeType,
    });
  }

  completeMultipart(
    objectKey: string,
    uploadId: string,
    parts: Array<{ part: number; etag?: string }>,
  ) {
    return this.client.completeMultipartUpload(this.bucket, objectKey, uploadId, parts);
  }

  listMultipartParts(
    objectKey: string,
    uploadId: string,
  ): Promise<Array<{ part: number; etag: string; size: number }>> {
    const client = this.client as unknown as {
      listParts: (
        bucketName: string,
        objectName: string,
        multipartUploadId: string,
      ) => Promise<Array<{ part: number; etag: string; size: number }>>;
    };
    return client.listParts(this.bucket, objectKey, uploadId);
  }

  abortMultipart(objectKey: string, uploadId: string): Promise<void> {
    return this.client.abortMultipartUpload(this.bucket, objectKey, uploadId);
  }
}
