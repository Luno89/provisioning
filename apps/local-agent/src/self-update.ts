export const BUNDLE_FILE = 'bundle.sha256';
export const SERVICE_UNIT = 'koala-machine.service';
export const LAUNCHD_LABEL = 'dev.koala.machine';

const SHA256 = /^[0-9a-f]{64}$/;

export type ServiceManager = 'systemd' | 'launchd';

export type UpdateState = 'waiting' | 'updating' | 'failed' | 'not-a-service';

export interface UpdateReport {
  state: UpdateState;
  bundle: string;
  reason?: string | undefined;
  busyWith?: string[] | undefined;
}

export function bundleIn(text: string | undefined): string | undefined {
  const first = text?.trim().split(/\s+/)[0]?.toLowerCase();
  return first && SHA256.test(first) ? first : undefined;
}

export function bundleNamed(raw: unknown): string | undefined {
  const named = raw && typeof raw === 'object' ? (raw as { sha256?: unknown }).sha256 : undefined;
  return typeof named === 'string' ? bundleIn(named) : undefined;
}

export function updateWanted(own: string | undefined, named: string | undefined): named is string {
  return Boolean(own && named && own !== named);
}

export function serviceManagerOf(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, cgroup: string | undefined): ServiceManager | undefined {
  if (platform === 'linux') {
    return env.INVOCATION_ID && cgroup?.split('\n').some((line) => line.endsWith(`/${SERVICE_UNIT}`)) ? 'systemd' : undefined;
  }
  if (platform === 'darwin') return env.XPC_SERVICE_NAME === LAUNCHD_LABEL ? 'launchd' : undefined;
  return undefined;
}

export const notAServiceSaid = (bundle: string): string =>
  `Koala has a newer machine agent (${bundle.slice(0, 12)}). This one was not started as the koala-machine service, so it does not restart itself onto it: run the command from My Machines again to install it.`;

export interface Gate {
  readonly idle: boolean;
  whenIdle(): Promise<void>;
  busyWith(): string[];
}

export interface SelfUpdateDeps {
  own: string | undefined;
  service: ServiceManager | undefined;
  gate: Gate;
  prepare(bundle: string): Promise<void>;
  discard(): Promise<void>;
  quiesce(): Promise<void>;
  resume(): Promise<void>;
  swap(): void;
  restart(bundle: string): void;
  report(report: UpdateReport): void;
  log(line: string): void;
}

export class SelfUpdate {
  private working: string | undefined;
  private wanted: string | undefined;
  private last: UpdateReport | undefined;
  private readonly told = new Set<string>();

  constructor(private readonly deps: SelfUpdateDeps) {}

  get busy(): boolean {
    return this.working !== undefined;
  }

  named(raw: unknown): Promise<void> {
    const bundle = bundleNamed(raw);
    if (!updateWanted(this.deps.own, bundle)) return Promise.resolve();
    this.wanted = bundle;
    if (!this.deps.service) {
      this.tell(`not-a-service ${bundle}`, notAServiceSaid(bundle));
      this.say({ state: 'not-a-service', bundle });
      return Promise.resolve();
    }
    if (this.working) {
      if (this.last) this.deps.report(this.last);
      return Promise.resolve();
    }
    return this.follow();
  }

  private async follow(): Promise<void> {
    while (this.wanted && this.wanted !== this.working) {
      const bundle = this.wanted;
      this.working = bundle;
      try {
        const done = await this.attempt(bundle);
        if (done) return;
      } finally {
        this.working = undefined;
      }
      if (this.wanted === bundle) return;
    }
  }

  private async attempt(bundle: string): Promise<boolean> {
    await this.untilIdle(bundle);
    this.say({ state: 'updating', bundle });
    this.deps.log(`updating this machine's agent to ${bundle.slice(0, 12)} while nothing runs on it`);
    try {
      await this.deps.prepare(bundle);
    } catch (err) {
      this.failed(bundle, (err as Error).message);
      return false;
    }
    if (this.wanted !== bundle) {
      await this.deps.discard().catch(() => undefined);
      return false;
    }
    for (;;) {
      await this.untilIdle(bundle);
      await this.deps.quiesce();
      if (this.deps.gate.idle) break;
      await this.deps.resume();
    }
    try {
      this.deps.swap();
    } catch (err) {
      await this.deps.resume();
      await this.deps.discard().catch(() => undefined);
      this.failed(bundle, `the new agent could not take the old one's place: ${(err as Error).message}`);
      return false;
    }
    this.deps.log(`the agent ${bundle.slice(0, 12)} is in place; this one stops so the ${this.deps.service} service starts it`);
    this.deps.restart(bundle);
    return true;
  }

  private async untilIdle(bundle: string): Promise<void> {
    while (!this.deps.gate.idle) {
      this.say({ state: 'waiting', bundle, busyWith: this.deps.gate.busyWith() });
      await this.deps.gate.whenIdle();
    }
  }

  private failed(bundle: string, reason: string): void {
    this.deps.log(`this machine's agent could not update itself to ${bundle.slice(0, 12)}, and keeps running as it is: ${reason}`);
    this.say({ state: 'failed', bundle, reason });
  }

  private say(report: UpdateReport): void {
    this.last = report;
    this.deps.report(report);
  }

  private tell(key: string, line: string): void {
    if (this.told.has(key)) return;
    this.told.add(key);
    this.deps.log(line);
  }
}
