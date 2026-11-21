import { reopening, untilAnswered, type Reopening } from '@koala/engine-core/reopening';
import type { ProvisionReport } from '@koala/engine-core/koala-install';
import type { InstanceStatus } from '../lib/instances.js';

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

  private async send(doing: string, body: Record<string, unknown>): Promise<Reported> {
    const call = this.deps.fetch ?? fetch;
    const log = this.deps.log ?? ((line: string) => console.log(line));
    const { url, instanceId, token } = this.deps.root;
    const answer = await untilAnswered(
      async () => call(`${url}/api/instances/status`, {
        method: 'POST',
        headers: { 'X-Instance-Id': instanceId, Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      this.wait,
      (why, seconds) => log(`root isn't answering when this instance ${doing} (${why}); asking again in ${seconds} s`),
    );
    if (answer.ok) return { ok: true };
    return { ok: false, status: answer.status, error: saidBy(await answer.text()) };
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
