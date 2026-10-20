export interface TrialView {
  trialEndsAt?: string | undefined;
}

export class InstanceTrial {
  private cached: { view: TrialView; at: number } | undefined;

  constructor(
    private readonly settings: { rootUrl: string; instanceId: string; credential: string },
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly now: () => number = Date.now,
    private readonly keepMs = 10 * 60_000,
  ) {}

  async read(): Promise<TrialView> {
    if (this.cached && this.now() - this.cached.at < this.keepMs) return this.cached.view;
    const response = await this.fetchImpl(`${this.settings.rootUrl}/api/instances/trial`, {
      headers: { 'x-instance-id': this.settings.instanceId, authorization: `Bearer ${this.settings.credential}` },
    });
    const answer = await response.json().catch(() => ({})) as TrialView & { error?: unknown };
    if (!response.ok) throw new Error(`root did not answer about this instance's trial (${response.status}): ${typeof answer.error === 'string' ? answer.error : 'no reason given'}`);
    const view = answer.trialEndsAt ? { trialEndsAt: answer.trialEndsAt } : {};
    this.cached = { view, at: this.now() };
    return view;
  }
}
