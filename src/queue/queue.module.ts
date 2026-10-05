import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { QueueService } from './queue.service';
import { DOCUMENT_PROCESSING_QUEUE } from './queue.constants';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const password = config.get<string>('REDIS_PASSWORD');

        return {
          connection: {
            host: config.getOrThrow<string>('REDIS_HOST'),
            port: Number(config.getOrThrow<string>('REDIS_PORT')),
            db: Number(config.getOrThrow<string>('REDIS_DB')),
            ...(password ? { password } : {}),
            maxRetriesPerRequest: null,
          },
          prefix: config.get<string>('BULLMQ_PREFIX', 'bull'),
        };
      },
    }),
    BullModule.registerQueue({ name: DOCUMENT_PROCESSING_QUEUE }),
  ],
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
