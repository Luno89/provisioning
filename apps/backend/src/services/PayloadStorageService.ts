import { WorkflowNotFoundError, type Client } from '@temporalio/client';
import { sweepPayloadBlobs, type PayloadBlobs, type SweepReport } from '../lib/payload-storage.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export class PayloadStorageService {
  constructor(
    private readonly blobs: PayloadBlobs,
    private readonly temporal: () => Promise<Client>,
    private readonly namespace = 'default',
  ) {}

  async retentionMs(): Promise<number> {
    const client = await this.temporal();
    const described = await client.workflowService.describeNamespace({ namespace: this.namespace });
    const seconds = Number(described.config?.workflowExecutionRetentionTtl?.seconds ?? 0);
    return seconds > 0 ? seconds * 1000 : DAY_MS;
  }

  async sweep(now = new Date()): Promise<SweepReport> {
    const client = await this.temporal();
    const exists = async (workflowId: string): Promise<boolean> => {
      try {
        await client.workflow.getHandle(workflowId).describe();
        return true;
      } catch (err) {
        if (err instanceof WorkflowNotFoundError) return false;
        throw err;
      }
    };
    return sweepPayloadBlobs(this.blobs, exists, { retentionMs: await this.retentionMs(), now });
  }
}
