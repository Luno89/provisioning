import { machineClusterId } from '../lib/machine-clusters.js';
import { stampedBody } from '../lib/machine-metrics.js';

export interface MachineMetricsDeps {
  admit(token: string): Promise<{ device: { id: string } } | string>;
  write(body: Buffer): Promise<{ status: number; text: string }>;
}

export interface RelayAnswer { status: number; text?: string | undefined }

export class MachineMetricsRelay {
  constructor(private readonly deps: MachineMetricsDeps) {}

  async write(token: string | undefined, body: Buffer): Promise<RelayAnswer> {
    if (!token) return { status: 401, text: 'a machine\'s Prometheus sends its metrics with the token root gave it for this Koala' };
    const admitted = await this.deps.admit(token);
    if (typeof admitted === 'string') return { status: 401, text: admitted };
    let stamped: Buffer;
    try {
      stamped = stampedBody(body, machineClusterId(admitted.device.id));
    } catch (err) {
      return { status: 400, text: `not a remote-write request Koala reads: ${(err as Error).message}` };
    }
    const answer = await this.deps.write(stamped);
    return answer.status < 300 ? { status: 204 } : { status: answer.status, text: answer.text.slice(0, 500) };
  }
}
