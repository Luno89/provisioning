import {
  DEFAULT_BENCH_SETTINGS,
  benchPlan,
  benchSettingsProblems,
  type BenchPlan,
  type BenchSettings,
  type BenchState,
} from '../lib/bench.js';
import type { BenchIdleOutcome, LifecycleEvent } from '../engine-host/temporal/contracts.js';
import type { Level2Run } from './Level2Service.js';
import type { MemoryItem, PracticeTrial } from '../lib/memory-store.js';
import { compareWithEarlier, type PromptChange, type PromptComparison } from '../lib/agent-changes.js';

export interface BenchStore {
  getBenchSettings(ownerId: string): Promise<BenchSettings | undefined>;
  saveBenchSettings(ownerId: string, settings: BenchSettings): Promise<void>;
  getBenchState(ownerId: string): Promise<BenchState | undefined>;
  saveBenchState(state: BenchState): Promise<void>;
  getUserById(id: string): Promise<{ space?: unknown; removal?: unknown } | undefined>;
}

export interface BenchDeps {
  store: BenchStore;
  scenarios: (ownerId: string) => Promise<{ id: string; agent: string }[]>;
  fingerprints: (ownerId: string, agents: readonly string[]) => Promise<Record<string, string>>;
  start: (ownerId: string, plan: BenchPlan, extra?: { trialPractice?: string; promptOverride?: { agent: string; prompt: string } }) => Promise<void>;
  changes: {
    pending(ownerId: string): Promise<PromptChange[]>;
    comparing(ownerId: string, id: string): Promise<void>;
    settle(ownerId: string, id: string, comparison: PromptComparison): Promise<PromptChange | undefined>;
  };
  earlier: (run: Level2Run) => Promise<Level2Run[]>;
  notifyChange: (ownerId: string, change: PromptChange) => void;
  practices: {
    trials(ownerId: string): Promise<MemoryItem[]>;
    settle(ownerId: string, id: string, trial: PracticeTrial, live: boolean): Promise<void>;
  };
  benchRunning: (ownerId: string) => Promise<boolean>;
  agentsRunning: () => Promise<boolean>;
  idleTimer: (ownerId: string, idleMs: number) => Promise<void>;
  notify: (ownerId: string, run: Level2Run) => void;
  now?: () => number;
}

export type SaveBenchSettingsOutcome = { saved: true; settings: BenchSettings } | { saved: false; problems: string[] };

export class BenchService {
  constructor(private readonly deps: BenchDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  async settings(ownerId: string): Promise<BenchSettings> {
    return (await this.deps.store.getBenchSettings(ownerId)) ?? { ...DEFAULT_BENCH_SETTINGS };
  }

  async saveSettings(ownerId: string, value: unknown): Promise<SaveBenchSettingsOutcome> {
    const problems = benchSettingsProblems(value);
    if (problems.length > 0) return { saved: false, problems };
    const { enabled, idleMinutes, fullEveryHours } = value as BenchSettings;
    const settings = { enabled, idleMinutes, fullEveryHours };
    await this.deps.store.saveBenchSettings(ownerId, settings);
    if (settings.enabled) await this.deps.idleTimer(ownerId, settings.idleMinutes * 60_000);
    return { saved: true, settings };
  }

  async state(ownerId: string): Promise<BenchState> {
    return (await this.deps.store.getBenchState(ownerId)) ?? { ownerId, benched: {} };
  }

  async activity(event: LifecycleEvent): Promise<void> {
    if (event.kind === 'conversation-quiet' || event.depth !== 0) return;
    await this.countDown(event.ownerId);
  }

  async changed(ownerId: string): Promise<void> {
    await this.countDown(ownerId);
  }

  async idle(ownerId: string): Promise<BenchIdleOutcome> {
    if (await this.deps.agentsRunning() || await this.deps.benchRunning(ownerId)) return 'busy';
    const state = await this.state(ownerId);
    const scenarios = await this.deps.scenarios(ownerId);

    const trials = (await this.deps.practices.trials(ownerId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const practice of trials) {
      const checks = scenarios.filter((scenario) => scenario.agent === practice.agent).map((scenario) => scenario.id);
      if (checks.length === 0) {
        await this.deps.practices.settle(ownerId, practice.id, { checkedAt: new Date(this.now()).toISOString(), unchecked: true }, true);
        continue;
      }
      await this.deps.start(ownerId, { trigger: { kind: 'practice', agent: practice.agent!, practiceId: practice.id }, scenarioIds: checks }, { trialPractice: practice.id });
      return 'started';
    }

    const changes = (await this.deps.changes.pending(ownerId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const change of changes) {
      const checks = scenarios.filter((scenario) => scenario.agent === change.agent).map((scenario) => scenario.id);
      if (checks.length === 0) {
        const settled = await this.deps.changes.settle(ownerId, change.id, { checkedAt: new Date(this.now()).toISOString(), scenarios: [], better: [], worse: [], unchecked: true });
        if (settled) this.deps.notifyChange(ownerId, settled);
        continue;
      }
      await this.deps.changes.comparing(ownerId, change.id);
      await this.deps.start(ownerId, { trigger: { kind: 'prompt-change', agent: change.agent, changeId: change.id }, scenarioIds: checks }, { promptOverride: { agent: change.agent, prompt: change.prompt } });
      return 'started';
    }

    const fingerprints = await this.deps.fingerprints(ownerId, [...new Set(scenarios.map((scenario) => scenario.agent))]);
    const plan = benchPlan(scenarios, fingerprints, state, await this.settings(ownerId), this.now());
    if (!plan) return 'nothing';

    await this.deps.start(ownerId, plan);
    const ran = plan.trigger.kind === 'full' ? Object.keys(fingerprints) : plan.trigger.kind === 'changed' ? plan.trigger.agents : [];
    await this.deps.store.saveBenchState({
      ownerId,
      benched: { ...state.benched, ...Object.fromEntries(ran.filter((agent) => fingerprints[agent]).map((agent) => [agent, fingerprints[agent]!])) },
      lastFullAt: plan.trigger.kind === 'full' ? new Date(this.now()).toISOString() : state.lastFullAt,
    });
    return 'started';
  }

  async finished(run: Level2Run): Promise<void> {
    if (run.trigger?.kind === 'practice' && run.state === 'done') {
      const regressions = run.regressions ?? [];
      await this.deps.practices.settle(run.ownerId, run.trigger.practiceId, {
        checkedAt: run.finishedAt ?? new Date(this.now()).toISOString(),
        runId: run.id,
        scenarios: run.scenarios,
        regressions,
      }, regressions.length === 0);
    }
    if (run.trigger?.kind === 'prompt-change') {
      if (run.state !== 'done') return;
      const settled = await this.deps.changes.settle(run.ownerId, run.trigger.changeId, {
        runId: run.id,
        checkedAt: run.finishedAt ?? new Date(this.now()).toISOString(),
        ...compareWithEarlier(run.results, await this.deps.earlier(run)),
      });
      if (settled) this.deps.notifyChange(run.ownerId, settled);
      return;
    }
    if ((run.regressions ?? []).length > 0) this.deps.notify(run.ownerId, run);
  }

  private async countDown(ownerId: string): Promise<void> {
    const owner = await this.deps.store.getUserById(ownerId);
    if (!owner || owner.space || owner.removal) return;
    const settings = await this.settings(ownerId);
    if (settings.enabled) await this.deps.idleTimer(ownerId, settings.idleMinutes * 60_000);
  }
}
