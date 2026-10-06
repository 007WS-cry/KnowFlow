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

  async enqueueDocumentProcessing(documentId: string, retryCount = 0): Promise<string> {
    const job = await this.documentQueue.add(
      'process-document',
      { documentId },
      {
        jobId: `${documentId}-r${retryCount}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 5_000 },
      },
    );

    return job.id ?? documentId;
  }

  async cancelDocumentProcessing(documentId: string): Promise<boolean> {
    try {
      const jobs = await this.documentQueue.getJobs(
        ['waiting', 'active', 'delayed', 'paused'],
        0,
        -1,
        true,
      );
      const matchingJobs = jobs.filter((job) => job.data?.documentId === documentId);
      if (matchingJobs.some((job) => job.processedOn && !job.finishedOn)) return false;
      await Promise.all(matchingJobs.map((job) => job.remove()));
      return true;
    } catch {
      // Deletion should still succeed if Redis is temporarily unavailable.
      return false;
    }
  }
}
