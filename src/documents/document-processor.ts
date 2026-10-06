import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { DocumentProcessingService } from './document-processing.service';
import { DOCUMENT_PROCESSING_QUEUE } from '../queue/queue.constants';

const concurrency = Math.max(
  1,
  Math.min(4, Number(process.env.DOCUMENT_PROCESSING_CONCURRENCY) || 1),
);

interface ProcessDocumentJob {
  documentId: string;
}

@Processor(DOCUMENT_PROCESSING_QUEUE, { concurrency })
export class DocumentProcessor extends WorkerHost {
  constructor(private readonly processing: DocumentProcessingService) {
    super();
  }

  async process(job: Job<ProcessDocumentJob>): Promise<void> {
    await this.processing.process(job.data.documentId);
  }
}
