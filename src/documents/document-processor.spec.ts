import { Job } from 'bullmq';
import { DocumentProcessingService } from './document-processing.service';
import { DocumentProcessor } from './document-processor';

describe('DocumentProcessor', () => {
  it('passes the queued document ID to the processing pipeline', async () => {
    const processing = { process: jest.fn().mockResolvedValue(undefined) };
    const processor = new DocumentProcessor(processing as unknown as DocumentProcessingService);
    const job = { data: { documentId: 'document-1' } } as Job<{ documentId: string }>;

    await processor.process(job);
    expect(processing.process).toHaveBeenCalledWith('document-1');
  });
});
