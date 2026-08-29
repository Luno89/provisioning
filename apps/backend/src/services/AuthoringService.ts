import type { ExperimentTask } from '@koala/harness-types';
import { boardFile } from '../lib/planning-board.js';
import { WorkspaceService } from './WorkspaceService.js';
import { imageForLanguage, DEFAULT_WORKSPACE_LANGUAGE } from '../lib/workspace-spec.js';
import {
  judgeEmptyRun, judgeSolutionRun, selfProvisionedInputs, type DraftTask,
} from '../lib/experiment-authoring.js';

const EMPTY_RUN_TIMEOUT_MS = 30_000;

const LIST_WORK = 'cd /work 2>/dev/null && ls -A 2>/dev/null | head -50 || true';

export interface ValidatedTask extends DraftTask {
  ok: boolean;
  reason?: string;
  exitCode: number;
  solutionExitCode?: number;
  output: string;
}

export class AuthoringService {
  constructor(
    private workspaces = new WorkspaceService(process.env.WORKSPACE_KUBECONFIG),
  ) {}

  async validateOnEmptyWorkspace(
    ownerId: string,
    tasks: DraftTask[],
    runId = `authoring-${Date.now().toString(36)}`,
  ): Promise<ValidatedTask[]> {
    if (!tasks.length) return [];

    const language = tasks.find((t) => t.language)?.language ?? DEFAULT_WORKSPACE_LANGUAGE;
    await this.workspaces.create({ leafId: runId, ownerId, image: imageForLanguage(language) });

    try {
      const out: ValidatedTask[] = [];
      for (const task of tasks) {
        await this.workspaces.exec(runId, 'rm -rf /work/* /work/.[!.]* 2>/dev/null; true');

        for (const f of task.seed ?? []) await this.workspaces.writeFile(runId, f.path, f.content);

        if (task.planning) {
          const empty = boardFile([]);
          await this.workspaces.writeFile(runId, empty.path, empty.content);
        }

        const before = await this.workspaces.exec(runId, LIST_WORK);

        const result = await this.workspaces.exec(
          runId,
          'sh -c "$0"',
          EMPTY_RUN_TIMEOUT_MS,
          [task.verifyCommand],
        );

        const after = await this.workspaces.exec(runId, LIST_WORK);
        const seeded = new Set(before.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
        const createdByVerify = after.stdout
          .split('\n').map((s) => s.trim()).filter(Boolean)
          .filter((f) => !seeded.has(f));
        const selfProvisioned = selfProvisionedInputs(task.prompt, createdByVerify);

        const verdict = judgeEmptyRun(result);
        const unanswerable = verdict.ok && selfProvisioned.length
          ? `the verify command creates ${selfProvisioned.join(', ')}, which the prompt asks the `
            + 'agent to read — during the run there is nothing there'
          : '';

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
      await this.workspaces.destroy(runId).catch(() => undefined);
    }
  }
}

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
