import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisCacheService.name);
  private readonly client: Redis;

  constructor(config: ConfigService) {
    const password = config.get<string>('REDIS_PASSWORD');
    this.client = new Redis({
      host: config.get<string>('REDIS_HOST', 'localhost'),
      port: Number(config.get<string>('REDIS_PORT', '6379')),
      db: Number(config.get<string>('REDIS_DB', '0')),
      ...(password ? { password } : {}),
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      keyPrefix: `${config.get<string>('BULLMQ_PREFIX', 'bull')}:cache:`,
    });
    this.client.on('error', (error: Error) =>
      this.logger.debug(`Redis cache unavailable: ${error.message}`),
    );
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const value = await this.client.get(key);
      return value ? (JSON.parse(value) as T) : null;
    } catch (error) {
      this.logger.debug(`Cache read skipped: ${String(error)}`);
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (error) {
      this.logger.debug(`Cache write skipped: ${String(error)}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client.status === 'ready') await this.client.quit();
    else this.client.disconnect();
  }
}
