import type { Database } from './db-interface.js';
import type { Leaf } from './leaves.js';
import type { ProjectMetadata } from './types.js';
import type { LeafChecks } from './leaf-trace.js';
import type { VerifyResult } from './leaf-verify.js';
import type { ArtifactOutcome } from './leaf-artifacts.js';
import { buildRepoStateScript, summariseRepoState, buildMergeScript, parseMergeResult } from './leaf-checkout.js';
import { redactSecrets } from './redact.js';
import { MAX_FINDINGS_CHARS } from './leaf-task-context.js';

export interface SettleWorkspace {
  exec(leafId: string, script: string, timeoutMs?: number, args?: string[]): Promise<{ stdout: string }>;
}

export interface SettleDeps {
  workspaces: SettleWorkspace;
  db: Pick<Database, 'saveLeaf'>;
  currentLeaf: () => Promise<Leaf | undefined>;
}

export interface SettleResult {
  leafId: string;
  tokensUsed: number;
  summary: string;
}

export interface SettleFailedParams {
  leafId: string;
  checkout: boolean;
  pushedBranch: string | undefined;
  project: Pick<ProjectMetadata, 'id'> | undefined;
  findings: string;
  spent: Leaf['usage'];
  runSucceeded: boolean;
  runSummary: string;
  verify: VerifyResult;
  artifactsOutcome: ArtifactOutcome;
  artifactsMissing: string[];
  dockerProblems: string;
  verifyCommand: string | undefined;
}

export async function settleFailedLeaf(deps: SettleDeps, params: SettleFailedParams): Promise<never> {
  const partial = params.pushedBranch;
  const state = params.checkout
    ? await deps.workspaces.exec(params.leafId, buildRepoStateScript(), 60_000)
        .then((r) => summariseRepoState(r.stdout))
        .catch(() => '')
    : '';

  const fresh = await deps.currentLeaf();
  if (fresh) {
    await deps.db.saveLeaf({
      ...fresh,
      ...(params.spent ? { usage: params.spent } : {}),
      ...(partial ? { outputBranch: partial } : {}),
      ...(params.project ? { projectId: params.project.id } : {}),
      ...(params.findings.trim() ? { findings: params.findings.slice(0, MAX_FINDINGS_CHARS) } : {}),
      updatedAt: new Date().toISOString(),
    });
  }

  throw new Error([
    params.verify.outcome === 'failed' && params.runSucceeded
      ? `The agent reported success, but the checks failed. Its report: ${params.runSummary}`
      : params.runSummary,
    ...(params.verify.outcome === 'failed' ? [`Verification failed (\`${params.verifyCommand}\`):\n${params.verify.output}`] : []),
    ...(params.artifactsOutcome === 'missing'
      ? [`These files were required and are not committed: ${params.artifactsMissing.join(', ')}. Create them and commit before finishing.`]
      : []),
    ...(params.dockerProblems ? [params.dockerProblems] : []),
    ...(partial ? [`Work so far is committed on ${partial} and will be waiting at /work/repo next attempt.`] : []),
    ...(state ? [`State of the repository when this attempt ended:\n${state}`] : []),
  ].join('\n\n'));
}

export interface SettleSucceededParams {
  leafId: string;
  pushedBranch: string | undefined;
  combined: 'passed' | 'failed' | 'unverified';
  dockerProblems: string;
  spent: Leaf['usage'];
  checks: LeafChecks;
  runSummary: string;
  runTokensUsed: number;
  project: Pick<ProjectMetadata, 'id'> | undefined;
  findings: string;
  secretsInPlay: () => (string | undefined)[];
}

export async function settleSucceededLeaf(deps: SettleDeps, params: SettleSucceededParams): Promise<SettleResult> {
  const outputBranch = params.pushedBranch;

  let merged = false;
  if (outputBranch && params.combined === 'passed' && !params.dockerProblems) {
    const result = await deps.workspaces
      .exec(params.leafId, buildMergeScript(outputBranch), 120_000, [outputBranch])
      .then((r) => parseMergeResult(r.stdout))
      .catch(() => 'skipped' as const);
    merged = result === 'merged';
    if (!merged) {
      console.warn(`[leaf-run-settle] leaf ${params.leafId} verified but not merged (${result}); work remains on ${outputBranch}`);
    }
  }

  const now = new Date().toISOString();
  const fresh = await deps.currentLeaf();
  if (fresh) {
    await deps.db.saveLeaf({
      ...fresh,
      ...(params.spent ? { usage: params.spent } : {}),
      status: 'succeeded',
      column: 'review',
      checks: params.checks,
      ...(params.runSummary ? { summary: redactSecrets(params.runSummary.slice(0, 8000), params.secretsInPlay()) } : {}),
      verified: params.combined === 'passed',
      merged,
      ...(params.project ? { projectId: params.project.id } : {}),
      ...(outputBranch ? { outputBranch } : {}),
      ...(params.findings.trim() ? { findings: params.findings.slice(0, MAX_FINDINGS_CHARS) } : {}),
      updatedAt: now,
    });
  }

  return { leafId: params.leafId, tokensUsed: params.runTokensUsed, summary: params.runSummary };
}
