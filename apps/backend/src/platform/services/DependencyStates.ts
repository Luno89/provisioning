import type { ObservableResult } from '@opentelemetry/api';
import { koalaMetrics } from '@koala/engine-core/telemetry';
import { reopening, type Reopening } from '@koala/engine-core/reopening';
import { DEPENDENCIES, DependencyDownError, failureOf, type DependencyDown, type DependencyId, type DependencyRefusals, type DependencyReporter, type DependencyState, type DependencyStateRow } from '../lib/dependencies.js';
import type { KoalaProcess } from '../lib/settings.js';

export type DependencyCheck = () => Promise<void>;

export interface DependencyStatesDeps {
  process: KoalaProcess;
  described: readonly DependencyId[];
  record?: ((row: DependencyStateRow) => Promise<void>) | undefined;
  where?: Partial<Record<DependencyId, string>> | undefined;
  firstMs?: number | undefined;
  now?: (() => Date) | undefined;
  log?: ((line: string) => void) | undefined;
}

const ANSWERING: DependencyState = { state: 'answering' };

export class DependencyStates implements DependencyReporter, DependencyRefusals {
  private readonly described: ReadonlySet<DependencyId>;
  private readonly states = new Map<DependencyId, DependencyState>();
  private readonly checks = new Map<DependencyId, DependencyCheck>();
  private readonly told = new Set<DependencyId>();
  private readonly timers = new Map<DependencyId, ReturnType<typeof setTimeout>>();
  private readonly backoff = new Map<DependencyId, Reopening>();
  private readonly unwritten = new Map<DependencyId, DependencyStateRow>();
  private readonly written = new Set<DependencyId>();
  private readonly strays = new Set<string>();
  private readonly listeners = new Map<DependencyId, (() => Promise<void> | void)[]>();
  private stopped = false;
  private readonly observe = (observed: ObservableResult): void => {
    for (const dependency of this.described) observed.observe(this.stateOf(dependency).state === 'answering' ? 1 : 0, { dependency });
  };

  constructor(private readonly deps: DependencyStatesDeps) {
    this.described = new Set(deps.described);
    koalaMetrics().dependencyUp.addCallback(this.observe);
  }

  uses(dependency: DependencyId): boolean {
    return this.described.has(dependency);
  }

  checkWith(dependency: DependencyId, check: DependencyCheck): void {
    if (!this.described.has(dependency)) return;
    this.checks.set(dependency, check);
    if (this.stateOf(dependency).state === 'down') this.schedule(dependency);
  }

  whenAnswering(dependency: DependencyId, heard: () => Promise<void> | void): void {
    if (!this.described.has(dependency)) return;
    this.listeners.set(dependency, [...(this.listeners.get(dependency) ?? []), heard]);
  }

  toldByConnection(dependency: DependencyId): void {
    if (!this.described.has(dependency)) return;
    this.told.add(dependency);
  }

  start(): Promise<void> {
    const unchecked = [...this.described].filter((dependency) => !this.checks.has(dependency) && !this.told.has(dependency));
    if (unchecked.length) throw new Error(`${this.deps.process} uses ${unchecked.join(', ')} and was given no way to check ${unchecked.length === 1 ? 'it' : 'them'}`);
    for (const dependency of this.told) if (!this.written.has(dependency)) this.write(dependency);
    return Promise.all([...this.described].filter((dependency) => this.checks.has(dependency)).map((dependency) => this.firstCheck(dependency))).then(() => undefined);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    koalaMetrics().dependencyUp.removeCallback(this.observe);
  }

  failed(dependency: DependencyId, error: unknown): unknown {
    if (!this.known(dependency)) return error;
    const failure = failureOf(error);
    if (failure.kind === 'final') return error;
    this.wentDown(dependency, failure.reason, this.now().toISOString());
    const state = this.stateOf(dependency);
    return state.state === 'down' ? new DependencyDownError(dependency, state.since, state.reason, { cause: error }) : error;
  }

  wentDown(dependency: DependencyId, reason: string, since: string): void {
    if (!this.known(dependency)) return;
    if (this.stateOf(dependency).state !== 'answering') return;
    this.states.set(dependency, { state: 'down', since, reason });
    this.say(`${DEPENDENCIES[dependency].name} isn't answering: ${reason}`);
    this.write(dependency);
    this.schedule(dependency);
  }

  refused(dependency: DependencyId, reason: string): void {
    if (!this.known(dependency)) return;
    if (this.stateOf(dependency).state === 'refused') return;
    const timer = this.timers.get(dependency);
    if (timer) clearTimeout(timer);
    this.timers.delete(dependency);
    this.states.set(dependency, { state: 'refused', since: this.now().toISOString(), reason });
    this.say(`${DEPENDENCIES[dependency].name} refused, will not retry: ${reason}`);
    this.write(dependency);
  }

  answered(dependency: DependencyId): void {
    if (!this.known(dependency)) return;
    if (dependency === 'mongo') this.flush();
    if (this.stateOf(dependency).state !== 'down') return;
    this.states.set(dependency, ANSWERING);
    const timer = this.timers.get(dependency);
    if (timer) clearTimeout(timer);
    this.timers.delete(dependency);
    this.backoff.get(dependency)?.reset();
    this.say(`${DEPENDENCIES[dependency].name} answers again`);
    this.write(dependency);
    this.tell(dependency);
  }

  private tell(dependency: DependencyId): void {
    for (const heard of this.listeners.get(dependency) ?? []) void heard();
  }

  stateOf(dependency: DependencyId): DependencyState {
    return this.states.get(dependency) ?? ANSWERING;
  }

  down(): DependencyDown[] {
    return [...this.described].flatMap((dependency) => {
      const state = this.stateOf(dependency);
      if (state.state === 'answering') return [];
      const where = this.deps.where?.[dependency];
      return [{ dependency, name: DEPENDENCIES[dependency].name, since: state.since, reason: state.reason, process: this.deps.process, ...(where ? { where } : {}), ...(state.state === 'refused' ? { refused: true as const } : {}) }];
    });
  }

  private known(dependency: DependencyId): boolean {
    if (this.described.has(dependency)) return true;
    if (!this.strays.has(dependency)) {
      this.strays.add(dependency);
      this.say(`was told about ${DEPENDENCIES[dependency].name}, which it is not described as using; check its wiring`);
    }
    return false;
  }

  private async firstCheck(dependency: DependencyId): Promise<void> {
    try {
      await this.checks.get(dependency)!();
      const recovers = this.stateOf(dependency).state === 'down';
      this.answered(dependency);
      if (!recovers) this.tell(dependency);
    } catch (err) {
      const failure = failureOf(err);
      if (failure.kind === 'temporary') this.failed(dependency, err);
      else this.wentDown(dependency, `its check at start was refused: ${failure.reason}`, this.now().toISOString());
    }
    if (!this.written.has(dependency)) this.write(dependency);
  }

  private schedule(dependency: DependencyId): void {
    if (this.stopped || this.timers.has(dependency) || !this.checks.has(dependency)) return;
    let backoff = this.backoff.get(dependency);
    if (!backoff) {
      backoff = reopening(this.deps.firstMs);
      this.backoff.set(dependency, backoff);
    }
    const timer = backoff.later(() => {
      this.timers.delete(dependency);
      void this.recheck(dependency);
    });
    timer.unref?.();
    this.timers.set(dependency, timer);
  }

  private async recheck(dependency: DependencyId): Promise<void> {
    if (this.stopped || this.stateOf(dependency).state !== 'down') return;
    try {
      await this.checks.get(dependency)!();
      this.answered(dependency);
    } catch {
      this.schedule(dependency);
    }
  }

  private write(dependency: DependencyId): void {
    const { record } = this.deps;
    if (!record || dependency === 'mongo') return;
    const state = this.stateOf(dependency);
    const row: DependencyStateRow = {
      process: this.deps.process,
      dependency,
      state: state.state,
      ...(state.state === 'answering' ? {} : { since: state.since, reason: state.reason }),
      at: this.now().toISOString(),
    };
    this.written.add(dependency);
    this.unwritten.delete(dependency);
    record(row).catch((err: unknown) => {
      if (!this.unwritten.size) this.say(`could not record what it sees of its dependencies (${(err as Error).message}); recording it when the database answers`);
      this.unwritten.set(dependency, row);
    });
  }

  private flush(): void {
    const rows = [...this.unwritten.values()];
    if (!rows.length || !this.deps.record) return;
    this.unwritten.clear();
    for (const row of rows) {
      this.deps.record(row).catch(() => {
        if (!this.unwritten.has(row.dependency)) this.unwritten.set(row.dependency, row);
      });
    }
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private say(line: string): void {
    (this.deps.log ?? ((message: string) => console.warn(message)))(`[dependencies] ${this.deps.process}: ${line}`);
  }
}
