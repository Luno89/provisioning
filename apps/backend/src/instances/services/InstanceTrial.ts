import { rootAnswer } from '../lib/root-answer.js';

export interface TrialView {
  trialEndsAt?: string | undefined;
}

export interface InstanceMoveView {
  state: 'waiting' | 'joined' | 'copying' | 'switching' | 'failed';
  detail?: string | undefined;
  machine?: string | undefined;
  startedAt: string;
}

export class RootRefused extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class InstanceTrial {
  private cached: { view: TrialView; at: number } | undefined;

  constructor(
    private readonly settings: { rootUrl: string; instanceId: string; token: () => Promise<string> },
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly now: () => number = Date.now,
    private readonly keepMs = 10 * 60_000,
  ) {}

  private async root<T>(method: string, path: string): Promise<T> {
    const response = await this.fetchImpl(`${this.settings.rootUrl}/api/instances${path}`, {
      method,
      headers: { 'x-instance-id': this.settings.instanceId, authorization: `Bearer ${await this.settings.token()}` },
    });
    const answer = rootAnswer(response.ok, response.status, await response.text());
    if (!response.ok) throw new RootRefused(response.status, answer.error ?? `root answered ${response.status}`);
    return answer.body as T;
  }

  startMove(): Promise<{ command: string; expiresAt: string }> {
    return this.root<{ command: string; expiresAt: string }>('POST', '/move/self').then(({ command, expiresAt }) => ({ command, expiresAt }));
  }

  async moveState(): Promise<InstanceMoveView | null> {
    return (await this.root<{ move: InstanceMoveView | null }>('GET', '/move/self')).move;
  }

  async stopMove(): Promise<void> {
    await this.root('DELETE', '/move/self');
  }

  async read(): Promise<TrialView> {
    if (this.cached && this.now() - this.cached.at < this.keepMs) return this.cached.view;
    const response = await this.fetchImpl(`${this.settings.rootUrl}/api/instances/trial`, {
      headers: { 'x-instance-id': this.settings.instanceId, authorization: `Bearer ${await this.settings.token()}` },
    });
    const answer = rootAnswer(response.ok, response.status, await response.text());
    if (!response.ok) throw new Error(`root did not answer about this instance's trial (${response.status}): ${answer.error ?? 'no reason given'}`);
    const { trialEndsAt } = answer.body as TrialView;
    const view = trialEndsAt ? { trialEndsAt } : {};
    this.cached = { view, at: this.now() };
    return view;
  }
}
