import type { ClusterMetadata } from '../../platform/index.js';
import { hashesEqual, metricsTokenHash, stampedBody } from '../lib/machine-metrics.js';

export interface MachineMetricsDeps {
  clusters(): Promise<ClusterMetadata[]>;
  write(body: Buffer): Promise<{ status: number; text: string }>;
}

export interface RelayAnswer { status: number; text?: string | undefined }

export class MachineMetricsRelay {
  constructor(private readonly deps: MachineMetricsDeps) {}

  async write(token: string | undefined, body: Buffer): Promise<RelayAnswer> {
    if (!token) return { status: 401, text: 'a machine sends its metrics with its cluster\'s metrics token' };
    const hash = metricsTokenHash(token);
    const cluster = (await this.deps.clusters()).find((entry) => entry.provider === 'machine' && entry.metricsTokenHash !== undefined && hashesEqual(entry.metricsTokenHash, hash));
    if (!cluster) return { status: 401, text: 'no machine\'s cluster sends with that token' };
    let stamped: Buffer;
    try {
      stamped = stampedBody(body, cluster.id);
    } catch (err) {
      return { status: 400, text: `not a remote-write request Koala reads: ${(err as Error).message}` };
    }
    const answer = await this.deps.write(stamped);
    return answer.status < 300 ? { status: 204 } : { status: answer.status, text: answer.text.slice(0, 500) };
  }
}
