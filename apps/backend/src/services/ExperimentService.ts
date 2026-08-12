/**
 * Runs harness experiments — the same A/B that would otherwise be a throwaway script.
 *
 * ── EACH RUN IS REAL ──
 * A real sandbox pod, a real model, real tokens. There is no simulation mode, because the whole
 * value of the exercise is measuring the thing that actually runs. That is also why the ceilings in
 * lib/experiments.ts exist and why `plannedRuns` is shown before starting.
 *
 * ── RUNS IN THE BACKGROUND, WRITES AS IT GOES ──
 * An experiment takes minutes, which is far longer than an HTTP request should live. The route
 * starts it and returns; this writes each variant's result to the database as it completes, so a
 * backend restart loses at most the run in flight rather than the whole experiment — and the UI can
 * poll rather than hold a connection open.
 */
import type { Server as SocketServer } from 'socket.io';
import type { Database } from '../lib/db-interface.js';
import type { ModelService } from './ModelService.js';
import { WorkspaceService } from './WorkspaceService.js';
import { runAgentLoop } from '../lib/agent-loop.js';
import { buildWebTools } from '../lib/web-tools-wiring.js';
import { agentRunOptions, wantsWeb } from '../lib/agent-run.js';
import { imageForLanguage, type EgressRule } from '../lib/workspace-spec.js';
import { type HarnessProfile } from '../lib/harness-profile.js';
import { resolveConfig, type Persona } from '../lib/personas.js';
import { flattenPersona, personaWorkspace } from '../lib/persona-scope.js';
import { runPlanningTurn } from '../lib/planning-turn.js';
import { boardFile } from '../lib/planning-board.js';
import type { LeafToolContext } from '../lib/leaf-tool-runner.js';
import type { ModelKind } from '@koala/harness-types';
import { buildMemoryContext, type MemoryItem } from '../lib/memory-store.js';
import type { ExperimentRun } from '@koala/harness-types';
import type {
  ExperimentRunFinished, ExperimentRunStarted, ExperimentStepEvent,
} from '@koala/harness-types';
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

/** How long one variant may take before it is abandoned and recorded as an error. */
const VARIANT_TIMEOUT_MS = 15 * 60_000;

/** How often a live run touches `updatedAt`, so staleness means something on a minutes-long variant. */
const HEARTBEAT_MS = 30_000;

/**
 * How quiet a `running` experiment must go before it is declared dead.
 *
 * Generously above the heartbeat: reaping a healthy run costs real sandboxes and orphans the pod
 * it was using, while leaving a dead one a few extra minutes costs a stale spinner.
 */
const STALE_AFTER_MS = 5 * 60_000;

export class ExperimentService {
  /** Experiments currently running, so a second Run click cannot start a duplicate. */
  private running = new Set<string>();
  private controllers = new Map<string, AbortController>();

  constructor(
    private db: Database,
    private models: ModelService,
    private workspaces = new WorkspaceService(process.env.WORKSPACE_KUBECONFIG),
    /**
     * Optional, so the service still runs headless.
     *
     * `lab-live.mts` constructs one with no server around it, and a live view is not something a
     * run should require in order to happen.
     */
    private io?: SocketServer,
    /**
     * How a research sub-agent reaches the web. Defaults to refusing, so a service constructed
     * without them plans from what the model knows rather than silently returning empty findings.
     */
    private webSearch: (q: string) => Promise<{ title: string; snippet: string; url: string }[]>
      = async () => [],
    private fetchWebPage: (url: string) => Promise<string> = async () => '',
  ) {}

  /**
   * Fire-and-forget: a run is never held up, or failed, by a display.
   *
   * The payload types are the shared ones the Lab consumes, so a renamed field is a compile error
   * here rather than an empty panel there.
   */
  private emit(event: 'experiment-run-started', payload: ExperimentRunStarted): void;
  private emit(event: 'experiment-step', payload: ExperimentStepEvent): void;
  private emit(event: 'experiment-run-finished', payload: ExperimentRunFinished): void;
  // The implementation takes the union rather than a bag: an interface has no implicit index
  // signature, so `Record<string, unknown>` would reject every one of the overloads above.
  private emit(
    event: string,
    payload: ExperimentRunStarted | ExperimentStepEvent | ExperimentRunFinished,
  ): void {
    try {
      this.io?.emit(event, payload);
    } catch {
      // A dropped frame is cosmetic; the measurement is what matters.
    }
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  /**
   * Closes out experiments that are genuinely dead — nothing is driving them any more.
   *
   * `running` is process memory, so a restart loses it while the DB record still says `running`.
   * Nothing then owns that experiment: the UI shows a spinner that never resolves, and because the
   * status is not terminal there is no Run button to start it again. The results already written
   * are kept — each variant was saved as it landed, and they are real measurements.
   *
   * ── WHY STALENESS AND NOT "NOT IN MY MEMORY" ──
   * This used to reconcile anything absent from `this.running`, which quietly assumed the backend
   * is the only process that ever runs an experiment. It is not: `lab-live.mts` constructs its own
   * service, and a second replica or an in-cluster runner would too. Measured the hard way — an
   * edit to a source file restarted the backend under `tsx watch`, bootstrap reconciled a suite
   * that a separate process was three minutes into, and the run died with a sandbox orphaned
   * behind it.
   *
   * A live run touches `updatedAt` on a heartbeat, so freshness is evidence about the WORK rather
   * than about this process's memory, and it is the same evidence whoever owns the run.
   */
  async reconcileInterrupted(staleAfterMs = STALE_AFTER_MS): Promise<number> {
    const cutoff = Date.now() - staleAfterMs;
    const stuck = (await this.db.getExperiments()).filter((e) => {
      if (e.status !== 'running' || this.running.has(e.id)) return false;
      const beat = Date.parse(e.updatedAt);
      // An unparseable timestamp is treated as stale: a record that cannot say when it last moved
      // is not one to leave spinning forever.
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
        // The execution is closed too, or the history keeps a run that claims to be in flight
        // forever — the same stuck spinner one level down.
        runs: closeRun(experiment.runs, experiment.runs?.[experiment.runs.length - 1]?.id ?? '', 'failed'),
        updatedAt: new Date().toISOString(),
      });
    }
    return stuck.length;
  }

  /**
   * Keeps `updatedAt` moving while a variant is in flight.
   *
   * Without it the only writes are one per variant, and a variant may legitimately take fifteen
   * minutes — so any staleness threshold short enough to be useful would reap healthy runs, and
   * any threshold long enough to be safe would leave a dead one spinning for a quarter of an hour.
   */
  private heartbeat(experimentId: string): () => void {
    const timer = setInterval(() => {
      void (async () => {
        const latest = (await this.db.getExperiments()).find((e) => e.id === experimentId);
        // Only while it is still running: a heartbeat landing after the terminal write would
        // resurrect the record's timestamp and confuse the next reconcile.
        if (latest?.status !== 'running') return;
        await this.db.saveExperiment({ ...latest, updatedAt: new Date().toISOString() });
      })().catch(() => undefined);
    }, HEARTBEAT_MS);
    // Never hold the process open for a heartbeat.
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

  /**
   * Fire-and-forget: a run is never held up, or failed, by a display.
   *
   * Deliberately not awaited by the caller. Errors are written onto the record rather than thrown,
   * because nothing is listening by the time most of them happen.
   */
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
    // `progress` and `error` are spelled out as clearable because finishing a run means writing
    // undefined over them, which exactOptionalPropertyTypes rejects on a plain Partial.
    patch: Omit<Partial<Experiment>, 'progress' | 'error'> & { progress?: string | undefined; error?: string | undefined },
  ): Promise<Experiment> {
    // Re-read before writing: the record may have been updated by an earlier variant, and a
    // full-object write from stale state would drop those results.
    const latest = (await this.db.getExperiments()).find((e) => e.id === experiment.id) ?? experiment;
    const next = { ...latest, ...patch, updatedAt: new Date().toISOString() };
    await this.db.saveExperiment(next);
    return next;
  }

  private async run(experiment: Experiment, signal?: AbortSignal): Promise<void> {
    const total = plannedRuns(experiment);
    const tasks = experimentTasks(experiment);
    // Once, before anything runs — see runVariant's `profile` parameter for why.
    const profile = await this.db.getHarnessProfile(experiment.ownerId);
    // Same reasoning, same snapshot: a persona edited mid-run must not make the arms after it
    // differ from the arms before it.
    const personas = (await this.db.getPersonas()).filter((p) => p.ownerId === experiment.ownerId);

    /**
     * A NEW execution, appended — never a reset.
     *
     * Starting a run used to clear `results`, which made an experiment something you could only ask
     * once: the whole reason to keep a suite is to ask it again after changing a prompt, a default
     * or a model, and that comparison is impossible if the previous numbers were deleted to make
     * room for the new ones. The conditions travel with the execution for the same reason — "the
     * numbers moved" means nothing without what moved with them.
     */
    const execution: ExperimentRun = {
      id: `r${Date.now().toString(36)}`,
      startedAt: new Date().toISOString(),
      status: 'running',
      ...(profile?.overrides ? { profileOverrides: profile.overrides } : {}),
      results: [],
    };
    /**
     * Evidence written before `runs[]` existed becomes execution one.
     *
     * Those records keep their results in the pre-history `results` field, which `latestResults`
     * only reads when there are no runs. Appending a new execution would therefore make the older
     * evidence invisible the first time an experiment was re-run — losing exactly the comparison
     * that re-running exists to produce.
     */
    const prior = priorExecutions(experiment);

    let current = await this.save(experiment, {
      status: 'running',
      error: undefined,
      runs: [...prior, execution],
    });

    // Runs for the whole experiment, not per variant: the gap this covers is the long stretch
    // inside a single variant where nothing else writes.
    const stopHeartbeat = this.heartbeat(experiment.id);

    let done = 0;
    try {
      /**
       * Task outermost, variants innermost — deliberately.
       *
       * An experiment takes hours and is routinely watched, stopped, or interrupted, so the order
       * decides what a partial result is worth. This way every task that has finished has finished
       * for ALL variants, and the matrix is complete down to the row it has reached. Looping
       * variant-outermost would instead give one variant's full suite and nothing to compare it
       * against — a result that cannot be read until the last run lands.
       */
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

            const result = await this.runVariant(experiment, task, variant, repeat, execution.id, profile, personas, signal);
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
      // Only reached for a failure OUTSIDE a variant — a variant's own failure is a result.
      await this.save(current, {
        status: 'failed',
        progress: undefined,
        error: String(err?.message ?? err).slice(0, 500),
        runs: closeRun(current.runs, execution.id, 'failed', String(err?.message ?? err).slice(0, 500)),
      });
    } finally {
      // In a finally, so a throw on the terminal write cannot leave a timer beating against a
      // record that has already stopped.
      stopHeartbeat();
    }
  }


  /**
   * One run of a PLANNING task — the decomposition cycle rather than the sandbox one.
   *
   * The agent never touches the sandbox here; it answers a request by proposing leaves. The
   * sandbox is used only at the end, to run the verify command against the board those leaves
   * form. That keeps one trust boundary rather than two: a predicate about decomposition quality
   * is arbitrary code, and it runs where all the other arbitrary code runs.
   *
   * A fresh branch per run, named from the run id. Reusing one would let a previous repeat's leaves
   * count toward this one's board — the same class of bug as reusing a sandbox namespace, which
   * cost 90 seconds and produced an error that read exactly like a failed task.
   */
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
          /**
           * The PLANNER gets no search, and is told so — it asks for findings instead, and a
           * sub-agent does the searching. So these stay empty here on purpose: they are the
           * planner's own tools, and it does not have them.
           */
          webSearch: async () => [],
          fetchWebPage: async () => '',
          /**
           * Inert on purpose — but only this one.
           *
           * `create_project` registers a real Gitea repository. A benchmark that quietly created
           * one per run would leave a trail of repos named after test prompts, and a measurement
           * that mutates the world outside the sandbox it was given is not a measurement.
           * `list_projects` returning nothing is honest here: this branch has none.
           */
          projects: {
            listForOwner: async () => [],
            register: async () => { throw new Error('Projects cannot be created from an experiment run.'); },
          } as unknown as LeafToolContext['projects'],
        },
        profile,
        persona,
        overrides: variant.overrides,
        // Research IS available — to the sub-agent, which is the whole point of the split: the
        // planning turn stays offline and reproducible while the information still arrives.
        research: { webSearch: this.webSearch, fetchWebPage: this.fetchWebPage },
        ...(signal ? { signal } : {}),
      }),
      VARIANT_TIMEOUT_MS,
    );

    // The board is the artifact. Written into a sandbox so the verify command reads it the same
    // way every other verify command reads its input.
    await this.workspaces.create({
      leafId: runId,
      ownerId: experiment.ownerId,
      image: imageForLanguage(task.language ?? experiment.language),
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
        // A planning turn has no `finish` tool, so there is no claim to compare against — it
        // proposed something or it did not.
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
          ...(resolved.from.persona.length ? { fromPersona: resolved.from.persona } : {}),
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
    /** The execution this run belongs to, so its sandbox cannot collide with a previous one. */
    executionId: string,
    /**
     * Resolved once for the whole experiment and passed down.
     *
     * Read per variant instead, a profile promoted while a multi-hour run is in flight would apply
     * to the variants after it and not the ones before — so the arms would differ in a way nothing
     * recorded, which is the exact failure the verify command exists to prevent elsewhere.
     */
    profile: HarnessProfile | null,
    /** Snapshotted with the profile, and for the same reason. */
    personas: Persona[],
    signal?: AbortSignal,
  ): Promise<VariantResult> {
    /**
     * What this arm actually runs: profile, then its persona, then its own overrides.
     *
     * The same chain the chat route uses, with the variant sitting where the request does — an arm
     * can borrow a persona and still change one knob, which is what makes "this persona but hotter"
     * expressible as a variant instead of a second persona.
     */
    /**
     * Flattened, so an arm can be "that persona, with one thing changed".
     *
     * Without this a variation means copying a persona, and a copy drifts from its original the
     * first time either is edited — which is fatal for a comparison whose whole point is that the
     * two differ in exactly one place.
     */
    const variantPersona = variant.personaId
      ? (() => { const found = personas.find((p) => p.id === variant.personaId); return found ? flattenPersona(found, personas) : null; })()
      : null;
    const resolvedForVariant = resolveConfig(profile, variantPersona, variant.overrides);
    if (resolvedForVariant.systemPrompt) {
      // The agent loop reads the prompt from the bag, unlike chat which composes it into a message.
      resolvedForVariant.overrides.systemPrompt = resolvedForVariant.systemPrompt;
    }
    // A variant override beats the task's language, which beats the suite default — the variant is
    // the thing under test, so it has to be able to make the language the axis.
    const language = variant.overrides.language ?? task.language ?? experiment.language;
    // Unique per run so repeats do not collide on a namespace, and so a leftover from a previous
    // experiment is never silently reused. Both slugs are short because this becomes a Kubernetes
    // namespace with a 63-character ceiling and a `koala-ws-` prefix already spent.
    /**
     * Unique per EXECUTION, not per experiment.
     *
     * This used to be derived from the experiment id alone, so re-running reused the same
     * namespace name — harmless when running once was all you could do, and a bug the moment run
     * history made re-running normal. Measured: a leftover from an interrupted attempt blocked the
     * new run for 90 seconds and then recorded an error that reads exactly like a failed task.
     *
     * Short slugs because this becomes a Kubernetes namespace with a 63-character ceiling and a
     * `koala-ws-` prefix already spent.
     */
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

      /**
       * A planning task never enters the sandbox loop.
       *
       * Dispatched here rather than branched through the block below, so the execution path stays
       * exactly as it was: it is the one every existing suite runs, and a planning feature is not
       * worth destabilising it for.
       */
      // A structural difference — the planning turn has no sandbox at all. `kind: 'planning'` is
      // still read, because experiments are stored documents that outlive a field rename.
      if (task.planning || (task as { kind?: string }).kind === 'planning') {
        return await this.runPlanningVariant(
          experiment, task, variant, runId, blank, startedAt,
          resolvedForVariant, variantPersona, profile,
          { model: provider.model, ...(provider.kind ? { kind: provider.kind } : {}) },
          baseUrl, apiKey, signal,
        );
      }

      /**
       * The same container a leaf would get, built by the same function.
       *
       * The Lab used to assemble its own and pass no network at all, so an arm could win here in an
       * environment no leaf ever runs in — which makes the result a fact about the bench rather
       * than about the persona.
       */
      await this.workspaces.create(personaWorkspace(
        variantPersona,
        { leafId: runId, ownerId: experiment.ownerId },
        { image: imageForLanguage(language) },
      ));

      /**
       * The world the agent wakes up in.
       *
       * Written before the loop starts, so the task can describe work ON something rather than
       * only work from nothing. `solution` is deliberately NOT written: it exists to prove the
       * verify command can pass, and putting it here would hand the agent the answer.
       */
      for (const file of task.seed ?? []) {
        await this.workspaces.writeFile(runId, file.path, file.content);
      }

      try {
        const memories = await this.db.getMemories(experiment.ownerId);
        const memoryContext = buildMemoryContext(memories, (experiment as any).projectId);

        const run = await withTimeout(
          runAgentLoop({
            baseUrl,
            apiKey,
            model: provider.model,
            ...(provider.kind ? { kind: provider.kind } : {}),
            language,
            // The same assembly a leaf gets. The Lab used to build its own, which is how it ended up
            // running forty steps with the code pacing note inside a sandbox with no repository —
            // benchmarking a harness that never ships.
            ...agentRunOptions(variantPersona, {
              taskContext: task.prompt,
              overrides: resolvedForVariant.overrides,
              memoryContext,
              fromProfile: resolvedForVariant.from.profile,
              fromPersona: resolvedForVariant.from.persona,
              ...(wantsWeb(variantPersona) ? { web: await buildWebTools(this.db, experiment.ownerId) } : {}),
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
            signal,
          }),
          VARIANT_TIMEOUT_MS,
        );

        // THE measurement. The agent's own `succeeded` is recorded beside it, never instead of it.
        // The task's own command — a suite checks different things per task, so there is no single
        // experiment-wide command that could stand in for this.
        const check = await this.workspaces.exec(runId, task.verifyCommand, 120_000);

        const toolsUsed = Array.from(
          new Set([
            ...(run.trace?.flatMap((t) => t.toolCalls?.map((c) => c.name) ?? []) ?? []),
            ...run.transcript.map((t) => t.split(' ')[0]!).filter(Boolean),
          ]),
        );

        // Expected dedicated tool mappings for verification
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
        };

        void this.autoExtractMemories(experiment, task, variant, variantResult).catch(() => undefined);
        return variantResult;
      } finally {
        await this.workspaces.destroy(runId).catch(() => undefined);
      }
    } catch (err: any) {
      // A broken endpoint is not a failed task, and recording it as one would poison the comparison.
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

/**
 * Both streams, tails kept.
 *
 * `stdout || stderr` used to be enough right up until it wasn't: a verify command that prints
 * anything at all on stdout — a test runner's progress dots — discarded stderr entirely, which is
 * exactly where the assertion that failed had written itself. The whole point of recording the
 * output is the failing case, so the failing case cannot be the one that gets dropped.
 */
function mergeStreams(stdout: string, stderr: string, max = 2000): string {
  const parts = [stdout.trim(), stderr.trim() ? `[stderr]\n${stderr.trim()}` : ''].filter(Boolean);
  // Tail, not head: a verify command's verdict is at the end of its output.
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

/** Appends a result to one execution, leaving every earlier execution untouched. */
function appendResult(
  runs: ExperimentRun[] | undefined,
  runId: string,
  result: VariantResult,
): ExperimentRun[] {
  return (runs ?? []).map((r) =>
    (r.id === runId ? { ...r, results: [...r.results, result] } : r));
}

/** Marks an execution finished. The results it collected stay exactly as they landed. */
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
