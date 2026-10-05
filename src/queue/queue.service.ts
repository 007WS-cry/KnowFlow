import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DOCUMENT_PROCESSING_QUEUE } from './queue.constants';

@Injectable()
export class QueueService {
  constructor(
    @InjectQueue(DOCUMENT_PROCESSING_QUEUE)
    private readonly documentQueue: Queue,
  ) {}

  async enqueueDocumentProcessing(documentId: string): Promise<string> {
    const job = await this.documentQueue.add(
      'process-document',
      { documentId },
      {
        jobId: documentId,
        attempts: 5,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 5_000 },
      },
    );

    return job.id ?? documentId;
  }

  async cancelDocumentProcessing(documentId: string): Promise<void> {
    try {
      const job = await this.documentQueue.getJob(documentId);
      if (!job || (await job.getState()) === 'active') return;
      await job.remove();
    } catch {
      // Deletion should still succeed if Redis is temporarily unavailable.
    }
  }
}
