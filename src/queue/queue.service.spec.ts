import { Queue } from 'bullmq';
import { QueueService } from './queue.service';

describe('QueueService', () => {
  it('adds one document job with a stable job ID and retry backoff', async () => {
    const queue = { add: jest.fn().mockResolvedValue({ id: 'document-1' }) };
    const service = new QueueService(queue as unknown as Queue);

    await expect(service.enqueueDocumentProcessing('document-1')).resolves.toBe('document-1');
    expect(queue.add).toHaveBeenCalledWith(
      'process-document',
      { documentId: 'document-1' },
      expect.objectContaining({
        jobId: 'document-1',
        attempts: 5,
        backoff: { type: 'exponential', delay: 1_000 },
      }),
    );
  });
});
