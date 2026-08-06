/**
 * Proving a proposed verify command actually checks something.
 *
 * ── THE GATE ──
 * `experiment-authoring.ts` can reject the obviously degenerate commands by inspection, but shell
 * is not statically analysable and the interesting failures are not obvious. `cd /work && ls` is a
 * perfectly ordinary-looking command that exits 0 on an empty directory, and a suite built from
 * commands like it reports every variant as a winner — the exact failure the whole Lab exists to
 * catch, produced automatically.
 *
 * So each command is RUN, in a fresh sandbox where no work has been done, and required to fail.
 * That is a fact rather than an inference.
 *
 * ── ONE SANDBOX FOR THE BATCH, RESET BETWEEN COMMANDS ──
 * A pod per command would make validating a suite as expensive as running it. One pod is enough,
 * but only if `/work` is emptied between commands: a verify command is allowed to create files,
 * and a leftover artefact from command three is exactly what would make command four pass
 * spuriously — reintroducing the bug this exists to prevent, one command later.
 */
import type { ExperimentTask } from '@koala/harness-types';
import { WorkspaceService } from './WorkspaceService.js';
import { imageForLanguage, DEFAULT_WORKSPACE_LANGUAGE } from '../lib/workspace-spec.js';
import {
  judgeEmptyRun, judgeSolutionRun, selfProvisionedInputs, type DraftTask,
} from '../lib/experiment-authoring.js';

/**
 * A verify command that has not failed within this has not failed usefully.
 *
 * Short on purpose: this runs against an EMPTY workspace, where a correct command fails almost
 * immediately — `test -f` and a missing `require` both return at once. Anything still going is
 * either hanging or doing work no verify command should be doing.
 */
const EMPTY_RUN_TIMEOUT_MS = 30_000;

/** Names only — contents are irrelevant here and could be large. */
const LIST_WORK = 'cd /work 2>/dev/null && ls -A 2>/dev/null | head -50 || true';

export interface ValidatedTask extends DraftTask {
  /** True when the command failed with only the seed AND passed on a correct solution. */
  ok: boolean;
  reason?: string;
  /** Exit code with only the seed present. Non-zero is what a real check does. */
  exitCode: number;
  /** Exit code with seed + solution. Zero is what an achievable task does. Absent with no solution. */
  solutionExitCode?: number;
  /** Trimmed output, so a failing command can be read without opening the sandbox. */
  output: string;
}

export class AuthoringService {
  constructor(
    private workspaces = new WorkspaceService(process.env.WORKSPACE_KUBECONFIG),
  ) {}

  /**
   * Runs every proposed verify command against an empty workspace.
   *
   * Returns a verdict per task rather than filtering: a rejected proposal is worth showing with
   * its reason, because "this command passes with no work done" is a useful thing to read and
   * often a small edit away from a good command.
   */
  async validateOnEmptyWorkspace(
    ownerId: string,
    tasks: DraftTask[],
    /** Distinct per call so two validations cannot land in the same namespace. */
    runId = `authoring-${Date.now().toString(36)}`,
  ): Promise<ValidatedTask[]> {
    if (!tasks.length) return [];

    // One image for the batch. A task naming another language still gets a fair test: the check is
    // whether the command fails with nothing present, which does not depend on the toolchain —
    // and a command that needs a missing tool exits 127, which is reported as its own verdict.
    const language = tasks.find((t) => t.language)?.language ?? DEFAULT_WORKSPACE_LANGUAGE;
    await this.workspaces.create({ leafId: runId, ownerId, image: imageForLanguage(language) });

    try {
      const out: ValidatedTask[] = [];
      for (const task of tasks) {
        // Emptied before EVERY command, including the first: a pod is fresh, but a retry or a
        // future caller reusing the id would not be.
        await this.workspaces.exec(runId, 'rm -rf /work/* /work/.[!.]* 2>/dev/null; true');

        // The seed is the world the agent would wake up in, so it is the baseline both sides of
        // the gate are measured against — not an empty directory.
        for (const f of task.seed ?? []) await this.workspaces.writeFile(runId, f.path, f.content);

        // Snapshotted AFTER seeding, so "what the verify command created" is a difference rather
        // than a listing. Without this a seeded file looks exactly like one the command wrote for
        // itself, and a correctly posed task gets rejected for the sin it was fixed to avoid.
        const before = await this.workspaces.exec(runId, LIST_WORK);

        /**
         * The command travels as a positional argument, never interpolated.
         *
         * It was written by a model. Splicing it into the command string would put it in the
         * container's process list and make any quote in it a shell injection — `WorkspaceService`
         * offers positionals for exactly this, and this is the case it was built for.
         */
        const result = await this.workspaces.exec(
          runId,
          'sh -c "$0"',
          EMPTY_RUN_TIMEOUT_MS,
          [task.verifyCommand],
        );

        /**
         * What the verify command left behind.
         *
         * Listed AFTER the run and before the next reset, so it is exactly the set of files the
         * command created for itself — the files the agent will not have. Names only; contents are
         * irrelevant and could be large.
         */
        const after = await this.workspaces.exec(runId, LIST_WORK);
        const seeded = new Set(before.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
        const createdByVerify = after.stdout
          .split('\n').map((s) => s.trim()).filter(Boolean)
          .filter((f) => !seeded.has(f));
        const selfProvisioned = selfProvisionedInputs(task.prompt, createdByVerify);

        const verdict = judgeEmptyRun(result);
        // A task whose input only exists at verification time is unanswerable however well the
        // agent works, so it fails the gate even when the command itself is a real check.
        const unanswerable = verdict.ok && selfProvisioned.length
          ? `the verify command creates ${selfProvisioned.join(', ')}, which the prompt asks the `
            + 'agent to read — during the run there is nothing there'
          : '';

        /**
         * The other side of the gate: does a correct answer actually pass?
         *
         * Only worth asking once the command has proved it is not vacuous, and only possible when
         * the task supplies a reference solution. Without one the task ships on half the evidence,
         * which is stated in the reason rather than left to be assumed.
         */
        let solutionExitCode: number | undefined;
        let unachievable = '';
        if (verdict.ok && !unanswerable && task.solution?.length) {
          for (const f of task.solution) await this.workspaces.writeFile(runId, f.path, f.content);
          const solved = await this.workspaces.exec(
            runId, 'sh -c "$0"', EMPTY_RUN_TIMEOUT_MS, [task.verifyCommand],
          );
          solutionExitCode = solved.exitCode;
          const achievable = judgeSolutionRun(solved);
          if (!achievable.ok) unachievable = achievable.reason ?? 'does not pass on a correct solution';
        }

        const reason = unanswerable || unachievable || verdict.reason;
        out.push({
          ...task,
          ok: verdict.ok && !unanswerable && !unachievable,
          ...(reason ? { reason } : {}),
          exitCode: result.exitCode,
          ...(solutionExitCode !== undefined ? { solutionExitCode } : {}),
          output: (result.stdout || result.stderr || '').trim().slice(0, 500),
        });
      }
      return out;
    } finally {
      // Even on a throw: an orphaned validation pod is a pod nothing will ever come back for.
      await this.workspaces.destroy(runId).catch(() => undefined);
    }
  }
}

/** The accepted tasks, in the shape the create route stores. Ids are assigned there, not here. */
export function acceptedTasks(validated: ValidatedTask[]): Omit<ExperimentTask, 'id'>[] {
  return validated
    .filter((t) => t.ok)
    .map((t) => ({
      name: t.name,
      prompt: t.prompt,
      verifyCommand: t.verifyCommand,
      ...(t.language ? { language: t.language } : {}),
    }));
}
