import { reopening, untilAnswered, type Reopening } from '@koala/engine-core/reopening';
import type { ProvisionReport } from '@koala/engine-core/koala-install';
import type { InstanceStatus } from '../lib/instances.js';
import type { DeletionProgress } from '../../projects/index.js';

export interface InstanceReporterDeps {
  root: { url: string; instanceId: string; token: () => Promise<string> };
  fetch?: typeof fetch;
  wait?: Reopening;
  log?: (line: string) => void;
}

export interface InstanceStatusReport {
  status: InstanceStatus;
  detail: string;
  imageTag?: string | undefined;
  dataVersion?: number | undefined;
  revision?: number | undefined;
}

export type Reported = { ok: true } | { ok: false; status: number; error: string };

export class InstanceReporter {
  private readonly wait: Reopening;

  constructor(private readonly deps: InstanceReporterDeps) {
    this.wait = deps.wait ?? reopening();
  }

  status(report: InstanceStatusReport): Promise<Reported> {
    return this.send(`tells it it is ${report.status}`, { ...report, presence: true });
  }

  setup(report: ProvisionReport): Promise<Reported> {
    return this.send(`tells it how its setup goes at ${report.progress.stage}`, { provision: report });
  }

  async ownerRemoval(progress: DeletionProgress): Promise<Reported> {
    const answer = await this.call('tells it how the removal of its owner stands', '/api/instances/owner-removal', { method: 'PUT', body: JSON.stringify({ progress }) });
    if (answer.ok) return { ok: true };
    return { ok: false, status: answer.status, error: saidBy(await answer.text()) };
  }

  async ownerRemoving(): Promise<boolean> {
    const answer = await this.call('asks it whether its owner is being removed', '/api/instances/owner-removal', { method: 'GET' });
    if (!answer.ok) throw new Error(`root would not say whether this instance's owner is being removed: ${saidBy(await answer.text())}`);
    return ((await answer.json()) as { removing?: unknown }).removing === true;
  }

  private async send(doing: string, body: Record<string, unknown>): Promise<Reported> {
    const answer = await this.call(doing, '/api/instances/status', { method: 'POST', body: JSON.stringify(body) });
    if (answer.ok) return { ok: true };
    return { ok: false, status: answer.status, error: saidBy(await answer.text()) };
  }

  private call(doing: string, path: string, init: { method: string; body?: string }): Promise<Response> {
    const call = this.deps.fetch ?? fetch;
    const log = this.deps.log ?? ((line: string) => console.log(line));
    const { url, instanceId, token } = this.deps.root;
    return untilAnswered(
      async () => call(`${url}${path}`, {
        ...init,
        headers: { 'X-Instance-Id': instanceId, Authorization: `Bearer ${await token()}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      }),
      this.wait,
      (why, seconds) => log(`root isn't answering when this instance ${doing} (${why}); asking again in ${seconds} s`),
    );
  }
}

function saidBy(text: string): string {
  try {
    const body = JSON.parse(text) as unknown;
    if (typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string') return (body as { error: string }).error;
  } catch {
    return text;
  }
  return text;
}
