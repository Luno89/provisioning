import type { Server as SocketServer } from 'socket.io';
import type { Database } from '../lib/db-interface.js';
import type { ModelService } from './ModelService.js';
import { WorkspaceService } from './WorkspaceService.js';
import { runAgentLoop } from '../lib/agent-loop.js';
import { buildWebTools } from '../lib/web-tools-wiring.js';
import { agentRunOptions, wantsWeb } from '../lib/agent-run.js';
import type { EgressRule } from '../lib/workspace-spec.js';
import { WorkspaceImageService } from './WorkspaceImageService.js';
import { type HarnessProfile } from '../lib/harness-profile.js';
import { resolveConfig, type Persona } from '../lib/personas.js';
import type { PersonaPack } from '@koala/harness-types';
import { ToolService } from './ToolService.js';
import { flattenPersona, personaWorkspace } from '../lib/persona-scope.js';
import { runPlanningTurn } from '../lib/planning-turn.js';
import { boardFile } from '../lib/planning-board.js';
import type { LeafToolContext } from '../lib/leaf-tool-runner.js';
import type { ModelKind } from '@koala/harness-types';
import { buildMemoryContext, type MemoryItem } from '../lib/memory-store.js';
import { buildDiffScript, trimDiff } from '../lib/leaf-evidence.js';
import type { ExperimentRun } from '@koala/harness-types';
import type {
  ExperimentRunFinished, ExperimentRunStarted, ExperimentStepEvent,
} from '@koala/harness-types';
import type { WebSearchFn } from '../lib/web-tools.js';
import {
  plannedRuns,
  experimentTasks,
  latestResults,
  priorExecutions,
  type Experiment,
  type ExperimentTask,
  type ExperimentVariant,
  type VariantResult,
} from '../lib/experiments.js';

const VARIANT_TIMEOUT_MS = 15 * 60_000;

const HEARTBEAT_MS = 30_000;

const STALE_AFTER_MS = 5 * 60_000;

export class ExperimentService {
  private running = new Set<string>();
  private controllers = new Map<string, AbortController>();

  constructor(
    private db: Database,
    private models: ModelService,
    private workspaces = new WorkspaceService(process.env.WORKSPACE_KUBECONFIG),
    private io?: SocketServer,
    private webSearch: WebSearchFn
      = async () => ({ hits: [], unavailable: true }),
    private fetchWebPage: (url: string) => Promise<string> = async () => '',
  ) {}

  private emit(event: 'experiment-run-started', payload: ExperimentRunStarted): void;
  private emit(event: 'experiment-step', payload: ExperimentStepEvent): void;
  private emit(event: 'experiment-run-finished', payload: ExperimentRunFinished): void;
  private emit(
    event: string,
    payload: ExperimentRunStarted | ExperimentStepEvent | ExperimentRunFinished,
  ): void {
    try {
      this.io?.emit(event, payload);
    } catch { /* ignored */ }
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  async reconcileInterrupted(staleAfterMs = STALE_AFTER_MS): Promise<number> {
    const cutoff = Date.now() - staleAfterMs;
    const stuck = (await this.db.getExperiments()).filter((e) => {
      if (e.status !== 'running' || this.running.has(e.id)) return false;
      const beat = Date.parse(e.updatedAt);
      return Number.isNaN(beat) || beat < cutoff;
    });

    for (const experiment of stuck) {
      await this.db.saveExperiment({
        ...experiment,
        status: 'failed',
        progress: undefined,
        error: `Stopped after ${latestResults(experiment).length} of ${plannedRuns(experiment)} runs — `
          + `nothing had updated it for ${Math.round(staleAfterMs / 60_000)} minutes. `
          + 'The results below are the ones that completed.',
        runs: closeRun(experiment.runs, experiment.runs?.[experiment.runs.length - 1]?.id ?? '', 'failed'),
        updatedAt: new Date().toISOString(),
      });
    }
    return stuck.length;
  }

  private heartbeat(experimentId: string): () => void {
    const timer = setInterval(() => {
      void (async () => {
        const latest = (await this.db.getExperiments()).find((e) => e.id === experimentId);
        if (latest?.status !== 'running') return;
        await this.db.saveExperiment({ ...latest, updatedAt: new Date().toISOString() });
      })().catch(() => undefined);
    }, HEARTBEAT_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  stop(experimentId: string): void {
    const controller = this.controllers.get(experimentId);
    if (controller) {
      controller.abort();
      this.controllers.delete(experimentId);
    }
    this.running.delete(experimentId);
  }

  start(experiment: Experiment): void {
    if (this.running.has(experiment.id)) return;
    const controller = new AbortController();
    this.controllers.set(experiment.id, controller);
    this.running.add(experiment.id);
    void this.run(experiment, controller.signal).finally(() => {
      this.running.delete(experiment.id);
      this.controllers.delete(experiment.id);
    });
  }

  private async save(
    experiment: Experiment,
    patch: Omit<Partial<Experiment>, 'progress' | 'error'> & { progress?: string | undefined; error?: string | undefined },
  ): Promise<Experiment> {
    const latest = (await this.db.getExperiments()).find((e) => e.id === experiment.id) ?? experiment;
    const next = { ...latest, ...patch, updatedAt: new Date().toISOString() };
    await this.db.saveExperiment(next);
    return next;
  }

  private async run(experiment: Experiment, signal?: AbortSignal): Promise<void> {
    const total = plannedRuns(experiment);
    const tasks = experimentTasks(experiment);
    const profile = await this.db.getHarnessProfile(experiment.ownerId);
    const personas = (await this.db.getPersonas()).filter((p) => p.ownerId === experiment.ownerId);
    const packs = (await this.db.getPersonaPacks()).filter((p) => p.ownerId === experiment.ownerId);

    const execution: ExperimentRun = {
      id: `r${Date.now().toString(36)}`,
      startedAt: new Date().toISOString(),
      status: 'running',
      ...(profile?.overrides ? { profileOverrides: profile.overrides } : {}),
      results: [],
    };
    const prior = priorExecutions(experiment);

    let current = await this.save(experiment, {
      status: 'running',
      error: undefined,
      runs: [...prior, execution],
    });

    const stopHeartbeat = this.heartbeat(experiment.id);

    let done = 0;
    try {
      const maxRepeats = Math.max(1, experiment.repeats ?? 1);
      for (let repeat = 0; repeat < maxRepeats; repeat++) {
        for (const task of tasks) {
          for (const variant of experiment.variants) {
            if (signal?.aborted) throw new Error('Experiment run was stopped.');
            done += 1;
            current = await this.save(current, {
              progress: `${done}/${total} — ${task.name} · ${variant.label}`
                + (maxRepeats > 1 ? ` (run ${repeat + 1})` : ''),
            });

            this.emit('experiment-run-started', {
              experimentId: experiment.id,
              taskId: task.id,
              taskName: task.name,
              label: variant.label,
              repeat,
              done,
              total,
            });

            const result = await this.runVariant(experiment, task, variant, repeat, execution.id, profile, personas, packs, signal);
            current = await this.save(current, {
              runs: appendResult(current.runs, execution.id, result),
            });

            this.emit('experiment-run-finished', {
              experimentId: experiment.id,
              taskId: task.id,
              label: variant.label,
              verified: result.verified,
              succeeded: result.succeeded,
              steps: result.steps,
              ...(result.error ? { error: result.error } : {}),
            });
          }
        }
      }
      await this.save(current, {
        status: 'complete',
        progress: undefined,
        runs: closeRun(current.runs, execution.id, 'complete'),
      });
    } catch (err: any) {
      await this.save(current, {
        status: 'failed',
        progress: undefined,
        error: String(err?.message ?? err).slice(0, 500),
        runs: closeRun(current.runs, execution.id, 'failed', String(err?.message ?? err).slice(0, 500)),
      });
    } finally {
      stopHeartbeat();
    }
  }

  private async runPlanningVariant(
    experiment: Experiment,
    task: ExperimentTask,
    variant: ExperimentVariant,
    runId: string,
    blank: Omit<VariantResult, 'durationMs'>,
    startedAt: number,
    resolved: ReturnType<typeof resolveConfig>,
    persona: Persona | null,
    profile: HarnessProfile | null,
    provider: { model: string; kind?: ModelKind },
    baseUrl: string,
    apiKey: string | undefined,
    signal?: AbortSignal,
  ): Promise<VariantResult> {
    const branchId = `plan-${runId}`;
    const personas = (await this.db.getPersonas()).filter((p) => p.ownerId === experiment.ownerId);
    const packs = (await this.db.getPersonaPacks()).filter((p) => p.ownerId === experiment.ownerId);

    const turn = await withTimeout(
      runPlanningTurn({
        baseUrl,
        ...(apiKey ? { apiKey } : {}),
        model: provider.model,
        ...(provider.kind ? { kind: provider.kind } : {}),
        prompt: task.prompt,
        tools: {
          db: this.db,
          userId: experiment.ownerId,
          branchId,
          webSearch: async () => ({ hits: [], unavailable: true }),
          fetchWebPage: async () => '',
          projects: {
            listForOwner: async () => [],
            register: async () => { throw new Error('Projects cannot be created from an experiment run.'); },
          } as unknown as LeafToolContext['projects'],
        },
        profile,
        persona,
        overrides: variant.overrides,
        research: { webSearch: this.webSearch, fetchWebPage: this.fetchWebPage },
        ...(signal ? { signal } : {}),
      }),
      VARIANT_TIMEOUT_MS,
    );

    await this.workspaces.create({
      leafId: runId,
      ownerId: experiment.ownerId,
      image: await new WorkspaceImageService(this.db).imageFor(
        experiment.ownerId, task.language ?? experiment.language,
      ),
    });
    try {
      for (const file of task.seed ?? []) {
        await this.workspaces.writeFile(runId, file.path, file.content);
      }
      const board = boardFile(turn.leaves, personas);
      await this.workspaces.writeFile(runId, board.path, board.content);

      const check = await this.workspaces.exec(runId, task.verifyCommand, 120_000);

      return {
        ...blank,
        succeeded: turn.leaves.length > 0,
        verified: check.exitCode === 0,
        verifyExitCode: check.exitCode,
        verifyOutput: mergeStreams(check.stdout, check.stderr),
        steps: turn.rounds,
        tokensUsed: turn.tokensUsed,
        durationMs: Date.now() - startedAt,
        summary: turn.reply.slice(0, 4000)
          || `Proposed ${turn.leaves.length} leaves without commenting on them.`,
        transcript: turn.toolCalls.map((c) => `${c.name} ${c.arguments}`),
        request: {
          systemPrompt: turn.request.systemPrompt,
          kickoff: task.prompt,
          tools: turn.request.tools.map((name) => ({ name, description: '' })),
          parameters: turn.request.parameters,
          overrides: resolved.overrides,
          fromProfile: resolved.from.profile,
                    ...(resolved.from.pack.length ? { fromPack: resolved.from.pack } : {}),
        },
        expected: {
          verifyCommand: task.verifyCommand,
          note: 'Verified when this exits 0 against the proposed board, written as leaves.json.',
        },
      };
    } finally {
      await this.workspaces.destroy(runId).catch(() => undefined);
    }
  }

  private async runVariant(
    experiment: Experiment,
    task: ExperimentTask,
    variant: ExperimentVariant,
    repeat: number,
    executionId: string,
    profile: HarnessProfile | null,
    personas: Persona[],
    packs: PersonaPack[],
    signal?: AbortSignal,
  ): Promise<VariantResult> {
    const variantPack = variant.packId
      ? packs.find((p) => p.id === variant.packId || p.slug === variant.packId) ?? null
      : null;
    const variantPersona = variantPack
      ? (() => { const found = personas.find((p) => p.id === variantPack.personaId); return found ? flattenPersona(found, personas) : null; })()
      : null;
    const resolvedForVariant = resolveConfig(profile, variantPack, variant.overrides, variantPersona);
    if (resolvedForVariant.systemPrompt) {
      resolvedForVariant.overrides.systemPrompt = resolvedForVariant.systemPrompt;
    }
    const language = variant.overrides.language ?? task.language ?? experiment.language;
    const runId = `exp-${executionId}-${slug(task.id, 10)}-${slug(variant.label, 12)}-${repeat}`;
    const startedAt = Date.now();

    const blank = {
      label: variant.label,
      taskId: task.id,
      succeeded: false,
      verified: false,
      verifyExitCode: -1,
      verifyOutput: '',
      steps: 0,
      tokensUsed: 0,
      summary: '',
      transcript: [] as string[],
    };

    try {
      const { provider, baseUrl, apiKey } = await this.models.resolveBaseUrl(
        experiment.ownerId,
        typeof variant.overrides.model === 'string' ? variant.overrides.model : undefined,
      );

      if (task.planning || (task as { kind?: string }).kind === 'planning') {
        return await this.runPlanningVariant(
          experiment, task, variant, runId, blank, startedAt,
          resolvedForVariant, variantPersona, profile,
          { model: provider.model, ...(provider.kind ? { kind: provider.kind } : {}) },
          baseUrl, apiKey, signal,
        );
      }

      await this.workspaces.create(personaWorkspace(
        await new WorkspaceImageService(this.db).list(experiment.ownerId),
        variantPack,
        { leafId: runId, ownerId: experiment.ownerId },
        { language },
      ));

      for (const file of task.seed ?? []) {
        await this.workspaces.writeFile(runId, file.path, file.content);
      }

      try {
        const memories = await this.db.getMemories(experiment.ownerId);
        const memoryContext = buildMemoryContext(memories, (experiment as any).projectId);

        const run = await withTimeout(
          runAgentLoop({
            catalogue: await new ToolService(this.db).schemas(experiment.ownerId),
            baseUrl,
            apiKey,
            model: provider.model,
            ...(provider.kind ? { kind: provider.kind } : {}),
            language,
            ...agentRunOptions(variantPack, {
              taskContext: task.prompt,
              overrides: resolvedForVariant.overrides,
              memoryContext,
              fromProfile: resolvedForVariant.from.profile,
                            fromPack: resolvedForVariant.from.pack,
              ...(wantsWeb(variantPack) ? { web: await buildWebTools(this.db, experiment.ownerId) } : {}),
              sandbox: {
                exec: (command) => this.workspaces.exec(runId, command),
                readFile: (path) => this.workspaces.readFile(runId, path),
                writeFile: (path, content) => this.workspaces.writeFile(runId, path, content),
              },
            }),
            captureTrace: true,
            onStep: (agentStep) => this.emit('experiment-step', {
              experimentId: experiment.id,
              taskId: task.id,
              label: variant.label,
              step: agentStep,
            }),
            ...(signal ? { signal } : {}),
          }),
          VARIANT_TIMEOUT_MS,
        );

        const check = await this.workspaces.exec(runId, task.verifyCommand, 120_000);

        const toolsUsed = Array.from(
          new Set([
            ...(run.trace?.flatMap((t) => t.toolCalls?.map((c) => c.name) ?? []) ?? []),
            ...run.transcript.map((t) => t.split(' ')[0]!).filter(Boolean),
          ]),
        );

        const dedicatedToolMap: Record<string, string> = {
          'tool-git-inspect': 'inspect_git_diff',
          'tool-http-test': 'test_http_endpoint',
          'tool-linter-audit': 'run_linter_audit',
          'tool-db-query': 'query_in_memory_db',
          'tool-save-memory': 'save_harness_memory',
          'tool-unit-tests': 'run_tests',
          'chat-t1': 'web_search',
          'chat-t2': 'web_search',
          'chat-t5': 'fetch_web_page',
        };
        const expectedTool = dedicatedToolMap[task.id];
        const usedDedicatedTool = expectedTool ? toolsUsed.includes(expectedTool) : undefined;

        const evidence = await this.workspaces
          .exec(runId, buildDiffScript(), 60_000, ['HEAD'])
          .then((r) => {
            const { diff, truncated } = trimDiff(r.stdout);
            return diff ? { diff, ...(truncated ? { diffTruncated: true } : {}) } : undefined;
          })
          .catch(() => undefined);

        const variantResult: VariantResult = {
          ...blank,
          succeeded: run.succeeded,
          verified: check.exitCode === 0,
          verifyExitCode: check.exitCode,
          verifyOutput: mergeStreams(check.stdout, check.stderr),
          steps: run.steps,
          tokensUsed: run.tokensUsed,
          durationMs: Date.now() - startedAt,
          summary: run.summary,
          transcript: run.transcript,
          request: run.request,
          expected: {
            verifyCommand: task.verifyCommand,
            note: 'Verified when this exits 0 in the sandbox after the agent stops.',
          },
          toolsUsed,
          ...(usedDedicatedTool !== undefined ? { usedDedicatedTool } : {}),
          ...(run.trace ? { trace: run.trace } : {}),
          ...(run.conversation ? { conversation: run.conversation } : {}),
          ...(evidence ? { evidence } : {}),
        };

        void this.autoExtractMemories(experiment, task, variant, variantResult).catch(() => undefined);
        return variantResult;
      } finally {
        await this.workspaces.destroy(runId).catch(() => undefined);
      }
    } catch (err: any) {
      return {
        ...blank,
        durationMs: Date.now() - startedAt,
        summary: 'Run did not complete.',
        error: String(err?.message ?? err).slice(0, 500),
      };
    }
  }

  private async autoExtractMemories(
    experiment: Experiment,
    task: ExperimentTask,
    variant: ExperimentVariant,
    result: VariantResult,
  ): Promise<void> {
    if (result.verified && result.succeeded) return;

    const output = (result.verifyOutput || '') + '\n' + (result.summary || '');
    let title = '';
    let text = '';
    let category: 'lessons_learned' | 'environment_facts' | 'prompt_guidance' = 'lessons_learned';
    let recommendedScope: 'project' | 'global' = 'project';

    if (output.includes('command not found') || output.includes('ENOENT')) {
      category = 'environment_facts';
      recommendedScope = 'global';
      title = `[Auto-Extracted] Missing Container Command on ${task.name}`;
      text = `A run for task "${task.name}" failed because a required command was missing in the container image: ${output.slice(0, 200).trim()}`;
    } else if (output.includes('Cannot find module') || output.includes('ERR_REQUIRE_ESM')) {
      category = 'lessons_learned';
      recommendedScope = 'global';
      title = `[Auto-Extracted] ESM / Module Resolution Error in ${task.name}`;
      text = `Module import/require syntax issue detected during task "${task.name}": ${output.slice(0, 200).trim()}`;
    } else if (!result.verified) {
      category = 'lessons_learned';
      recommendedScope = 'project';
      title = `[Auto-Extracted] Verification Failure on ${task.name}`;
      text = `Task "${task.name}" (${variant.label}) failed verification (exit code ${result.verifyExitCode}): ${output.slice(0, 250).trim()}`;
    }

    if (!title) return;

    const memoryItem: MemoryItem = {
      id: `mem_auto_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      ownerId: experiment.ownerId,
      projectId: (experiment as any).projectId,
      category,
      scope: 'project',
      recommendedScope,
      status: 'pending_review',
      title,
      text,
      source: 'post_run_extractor',
      provenance: {
        experimentId: experiment.id,
        taskId: task.id,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await this.db.saveMemory(memoryItem);
  }
}

function mergeStreams(stdout: string, stderr: string, max = 2000): string {
  const parts = [stdout.trim(), stderr.trim() ? `[stderr]\n${stderr.trim()}` : ''].filter(Boolean);
  return parts.join('\n').slice(-max);
}

const slug = (text: string, max = 24) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '') || 'x';

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Variant exceeded ${Math.round(ms / 60_000)} minutes`)), ms),
    ),
  ]);
}

function appendResult(
  runs: ExperimentRun[] | undefined,
  runId: string,
  result: VariantResult,
): ExperimentRun[] {
  return (runs ?? []).map((r) =>
    (r.id === runId ? { ...r, results: [...r.results, result] } : r));
}

function closeRun(
  runs: ExperimentRun[] | undefined,
  runId: string,
  status: 'complete' | 'failed',
  error?: string,
): ExperimentRun[] {
  return (runs ?? []).map((r) => (r.id === runId
    ? { ...r, status, finishedAt: new Date().toISOString(), ...(error ? { error } : {}) }
    : r));
}
