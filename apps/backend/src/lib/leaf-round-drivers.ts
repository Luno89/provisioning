import { v4 as uuidv4 } from 'uuid';
import type { AgentStep } from '@koala/harness-types';
import type { Database } from './db-interface.js';
import type { Leaf } from './leaves.js';
import { rootLeaf, aggregateUsage } from './leaves.js';
import type { MemoryItem } from './memory-store.js';
import type { Decision } from './memory-decide.js';
import type { SandboxDriver, ExtendBudgetDriver, CheckpointDriver, AgentRunOptions } from './agent-loop.js';
import type { FileConventions } from './tree-type-conventions.js';
import { redactDeep, redactSecrets } from './redact.js';
import {
  buildProgressScript, parseProgress, buildCheckpointScript, parseCheckpointResult, checkpointPath,
} from './leaf-checkout.js';
import { buildArtifactCheckScript, parseArtifactResult } from './leaf-artifacts.js';
import { compareProgress, decideExtension, refusalReason, type ProgressSample } from './budget-extension.js';
import { assessFindings } from './research-verify.js';
import { buildCheckpointArtifact } from './leaf-checkpoint.js';
import { MAX_FINDINGS_CHARS } from './leaf-task-context.js';

export interface RepoProgressWorkspace {
  exec(leafId: string, script: string, timeoutMs?: number, args?: string[]): Promise<{ stdout: string }>;
}

export async function readRepoProgress(
  workspaces: RepoProgressWorkspace,
  leafId: string,
  base: string,
): Promise<{ commits: number; changedLines: number; raw: { commits: string; changed: string } }> {
  const raw = await workspaces
    .exec(leafId, buildProgressScript(), 60_000, [base])
    .then((r) => parseProgress(r.stdout))
    .catch(() => ({ commits: '', changed: '' }));
  const commits = raw.commits ? raw.commits.split('\n').filter(Boolean).length : 0;
  const changed = /(\d+) insertions?\(\+\)/.exec(raw.changed);
  const changedLines = changed?.[1] ? Number(changed[1]) : 0;
  return { commits, changedLines, raw };
}

export interface DocumentProgressWorkspace {
  readFile(leafId: string, path: string): Promise<string>;
}

export async function readDocumentProgress(
  workspaces: DocumentProgressWorkspace,
  leafId: string,
  outputPath: string,
  requireSources: boolean,
): Promise<{ text: string; chars: number; outcome: 'passed' | 'failed'; reason: string }> {
  const text = await workspaces.readFile(leafId, outputPath).catch(() => '');
  const verdict = assessFindings(text, outputPath, requireSources);
  return { text, chars: text.length, outcome: verdict.outcome, reason: verdict.reason };
}

export function buildOnStepDriver(
  deps: { db: Pick<Database, 'appendLeafStep'> },
  leaf: Pick<Leaf, 'id' | 'ownerId' | 'branchId'>,
  secretsInPlay: () => (string | undefined)[],
  onBeat: (step: AgentStep) => void,
): (step: AgentStep) => void {
  return (step) => {
    onBeat(step);
    void deps.db.appendLeafStep({
      id: leaf.id,
      ownerId: leaf.ownerId,
      branchId: leaf.branchId,
      step: redactDeep(step, secretsInPlay()),
      totalSteps: step.step,
      tokensUsed: step.tokens,
      createdAt: new Date().toISOString(),
    }).catch((err) => {
      console.warn(`[leaf-round-drivers] leaf ${leaf.id}: could not record step ${step.step}: ${err?.message}`);
    });
  };
}

export function buildSandboxDriver(
  workspaces: {
    exec(leafId: string, command: string): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>;
    readFile(leafId: string, path: string): Promise<string>;
    writeFile(leafId: string, path: string, content: string): Promise<void>;
  },
  leafId: string,
): SandboxDriver {
  return {
    exec: (command) => workspaces.exec(leafId, command),
    readFile: (path) => workspaces.readFile(leafId, path),
    writeFile: (path, content) => workspaces.writeFile(leafId, path, content),
  };
}

export function buildSaveMemoryDriver(
  admit: (item: MemoryItem) => Promise<Decision>,
  leaf: Pick<Leaf, 'id' | 'ownerId' | 'projectId'>,
  secretsInPlay: () => (string | undefined)[],
): NonNullable<AgentRunOptions['saveMemory']> {
  return async ({ category, title, text, suggestedScope }) => {
    const at = new Date().toISOString();
    const decision = await admit({
      id: uuidv4(),
      ownerId: leaf.ownerId,
      ...(leaf.projectId ? { projectId: leaf.projectId } : {}),
      category: category as 'lessons_learned' | 'environment_facts' | 'prompt_guidance',
      scope: 'project',
      recommendedScope: suggestedScope,
      status: 'active',
      title: redactSecrets(title.slice(0, 200), secretsInPlay()),
      text: redactSecrets(text.slice(0, 4000), secretsInPlay()),
      source: 'agent_tool',
      provenance: { taskId: leaf.id },
      createdAt: at,
      updatedAt: at,
    });
    return { action: decision.action };
  };
}

export interface ProgressCell {
  get(): ProgressSample | undefined;
  set(sample: ProgressSample): void;
}

export interface ExtendBudgetDeps {
  workspaces: RepoProgressWorkspace & DocumentProgressWorkspace;
  db: Pick<Database, 'getLeaves'>;
}

export interface ExtendBudgetContext {
  leaf: Leaf;
  checkout: boolean;
  branchName: string | undefined;
  defaultBranch: string;
  outputPath: string | undefined;
  conventions: FileConventions | undefined;
  requireSources: boolean;
  progress: ProgressCell;
  onBeat: (step: number) => void;
}

export function buildExtendBudgetDriver(deps: ExtendBudgetDeps, ctx: ExtendBudgetContext): ExtendBudgetDriver {
  return async (req) => {
    try {
      ctx.onBeat(req.step);

      const current: ProgressSample = { at: { step: req.step, tokens: req.tokensUsed } };

      if (ctx.checkout && ctx.branchName) {
        const rp = await readRepoProgress(deps.workspaces, ctx.leaf.id, ctx.defaultBranch);
        current.commits = rp.commits;
        current.changedLines = rp.changedLines;

        if (ctx.leaf.expects?.length) {
          const artifacts = await deps.workspaces
            .exec(ctx.leaf.id, buildArtifactCheckScript(ctx.leaf.expects, ctx.defaultBranch, ctx.conventions), 60_000)
            .then((r) => parseArtifactResult(r.stdout))
            .catch(() => undefined);
          if (artifacts) current.missingArtifacts = artifacts.missing.length;
        }
      } else if (ctx.outputPath) {
        const progress = await readDocumentProgress(deps.workspaces, ctx.leaf.id, ctx.outputPath, ctx.requireSources);
        current.findingsChars = progress.chars;
        current.findingsOutcome = progress.outcome;
      }

      const evidence = compareProgress(ctx.progress.get(), current);
      ctx.progress.set(current);

      let headroomTokens: number | undefined;
      const all = await deps.db.getLeaves().catch(() => [] as Leaf[]);
      const root = rootLeaf(all, ctx.leaf);
      if (root?.budget?.maxTokens !== undefined) {
        const used = aggregateUsage(all, root, Date.now());
        headroomTokens = Math.max(0, root.budget.maxTokens - used.tokens);
      }

      const extensionState = {
        exhausted: req.exhausted,
        extensionsUsed: req.extensionsUsed,
        evidence,
        thrashing: req.thrashing,
        circling: req.circling,
        silent: req.silent,
        originalMaxSteps: req.originalMaxSteps,
        originalMaxTokens: req.originalMaxTokens,
        headroomTokens,
      };
      const decision = decideExtension(extensionState);

      console.log(
        `[leaf-round-drivers] leaf ${ctx.leaf.id}: budget ${req.exhausted} exhausted at step `
        + `${req.step} — ${decision ? decision.reason : `no extension: ${refusalReason(extensionState) ?? 'refused'}`}`,
      );
      return decision;
    } catch (err: any) {
      console.warn(`[leaf-round-drivers] leaf ${ctx.leaf.id}: extension probe failed: ${err?.message}`);
      return undefined;
    }
  };
}

export interface CheckpointDeps {
  workspaces: RepoProgressWorkspace & DocumentProgressWorkspace & {
    writeFile(leafId: string, path: string, content: string): Promise<unknown>;
  };
  db: Pick<Database, 'saveLeaf'>;
  currentLeaf: () => Promise<Leaf | undefined>;
}

export interface CheckpointContext {
  leaf: Pick<Leaf, 'id' | 'title'>;
  checkout: boolean;
  branchName: string | undefined;
  defaultBranch: string;
  outputPath: string | undefined;
  requireSources: boolean;
  progress: ProgressCell;
  onBeat: (number: number) => void;
}

export function buildCheckpointDriver(deps: CheckpointDeps, ctx: CheckpointContext): CheckpointDriver {
  return async ({ number, handoff, tokensUsed: tokensUsedAtCheckpoint, maxTokens }) => {
    try {
      ctx.onBeat(number);

      const artifactPath = checkpointPath(ctx.leaf.id);
      const common = {
        number,
        taskTitle: ctx.leaf.title,
        at: new Date().toISOString(),
        tokensUsed: tokensUsedAtCheckpoint,
        maxTokens,
        handoff,
      };

      if (!ctx.checkout || !ctx.branchName) {
        if (!ctx.outputPath) return undefined;
        const progress = await readDocumentProgress(deps.workspaces, ctx.leaf.id, ctx.outputPath, ctx.requireSources);

        const artifact = buildCheckpointArtifact({
          ...common,
          findings: { path: ctx.outputPath, outcome: progress.outcome, reason: progress.reason, chars: progress.chars },
        });

        const fresh = await deps.currentLeaf();
        if (fresh && progress.text.trim()) {
          await deps.db.saveLeaf({ ...fresh, findings: progress.text.slice(0, MAX_FINDINGS_CHARS), updatedAt: new Date().toISOString() });
        }
        ctx.progress.set({
          at: { step: 0, tokens: tokensUsedAtCheckpoint },
          findingsChars: progress.chars,
          findingsOutcome: progress.outcome,
        });

        console.log(
          `[leaf-round-drivers] leaf ${ctx.leaf.id}: checkpoint ${number} saved `
          + `${progress.chars} chars of ${ctx.outputPath} (${progress.outcome})`,
        );
        return { artifact };
      }

      const rp = await readRepoProgress(deps.workspaces, ctx.leaf.id, ctx.defaultBranch);
      const artifact = buildCheckpointArtifact({
        ...common,
        repo: { branch: ctx.branchName, commits: rp.raw.commits, changed: rp.raw.changed },
      });

      ctx.progress.set({
        at: { step: 0, tokens: tokensUsedAtCheckpoint },
        commits: rp.commits,
        changedLines: rp.changedLines,
      });

      await deps.workspaces.writeFile(ctx.leaf.id, `/work/repo/${artifactPath}`, artifact);

      const saved = await deps.workspaces
        .exec(ctx.leaf.id, buildCheckpointScript(), 120_000, [ctx.branchName, artifactPath])
        .then((r) => parseCheckpointResult(r.stdout))
        .catch(() => undefined);

      if (saved) {
        const fresh = await deps.currentLeaf();
        if (fresh) {
          await deps.db.saveLeaf({ ...fresh, outputBranch: saved.branch, updatedAt: new Date().toISOString() });
        }
      }

      console.log(
        `[leaf-round-drivers] leaf ${ctx.leaf.id}: checkpoint ${number} `
        + `${saved ? `pushed ${saved.branch}@${saved.sha}` : 'written (not pushed)'}`,
      );

      return {
        artifact,
        ...(saved?.sha ? { sha: saved.sha } : {}),
        ...(saved?.branch ? { branch: saved.branch } : {}),
      };
    } catch (err: any) {
      console.warn(`[leaf-round-drivers] leaf ${ctx.leaf.id}: checkpoint ${number} failed: ${err?.message}`);
      return undefined;
    }
  };
}
