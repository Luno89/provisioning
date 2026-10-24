import type { UpdatesView } from '../lib/instance-updates.js';

export interface InstanceUpdatesSettings {
  rootUrl: string;
  instanceId: string;
  credential: string;
  cronJob?: string | undefined;
  namespace?: string | undefined;
}

export interface UpdatesAnswer extends UpdatesView {
  checking?: string | undefined;
}

export class InstanceUpdates {
  constructor(
    private readonly settings: InstanceUpdatesSettings,
    private readonly kubectl: (args: string[]) => Promise<string>,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async call(method: 'GET' | 'PUT', body?: unknown): Promise<UpdatesView> {
    const response = await this.fetchImpl(`${this.settings.rootUrl}/api/instances/updates`, {
      method,
      headers: { 'content-type': 'application/json', 'x-instance-id': this.settings.instanceId, authorization: `Bearer ${this.settings.credential}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const answer = await response.json().catch(() => ({})) as UpdatesView & { error?: unknown };
    if (!response.ok) throw new UpdatesRefused(response.status, typeof answer.error === 'string' ? answer.error : `root answered ${response.status} about this instance's updates`);
    return answer;
  }

  private async checkingNow(): Promise<string | undefined> {
    const { cronJob, namespace } = this.settings;
    if (!cronJob || !namespace) return undefined;
    const jobs = JSON.parse(await this.kubectl(['get', 'jobs', '-n', namespace, '-o', 'json'])) as { items: { metadata: { name: string }; status?: { active?: number } }[] };
    return jobs.items.find((job) => job.metadata.name.startsWith(`${cronJob}-`) && (job.status?.active ?? 0) > 0)?.metadata.name;
  }

  async checkNow(): Promise<string> {
    const { cronJob, namespace } = this.settings;
    if (!cronJob || !namespace) throw new UpdatesRefused(409, 'this instance has no check-in to start: it was installed without a credential from root');
    const running = await this.checkingNow();
    if (running) return running;
    const name = `${cronJob}-${this.now().getTime().toString(36)}`;
    await this.kubectl(['create', 'job', `--from=cronjob/${cronJob}`, name, '-n', namespace]);
    return name;
  }

  async view(): Promise<UpdatesAnswer> {
    const [view, checking] = await Promise.all([this.call('GET'), this.checkingNow().catch(() => undefined)]);
    return { ...view, ...(checking ? { checking } : {}) };
  }

  async set(change: { auto?: boolean; version?: string }): Promise<UpdatesAnswer> {
    const view = await this.call('PUT', change);
    if (view.target === view.running) return view;
    return { ...view, checking: await this.checkNow() };
  }
}

export class UpdatesRefused extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
