import type { WorkspaceService } from '../services/WorkspaceService.js';
import type { ValidationExecutionEnvironment, ValidationSummary } from '../services/UniversalValidatorService.js';
import type { ValidationRecipe } from './tree-types.js';
import {
  assessLoopProgress, recordFromSummary, writeValidationArtifacts,
  type ValidationRoundRecord, type LoopProgressAssessment,
} from './worker-validator-loop.js';
import { buildRepoDetailScript, parseRepoDetail } from './leaf-checkout.js';
import { buildValidatorEnv } from './validator-env.js';

export interface RecipeResolverDeps {
  validator: { inferRecipe(env: ValidationExecutionEnvironment): Promise<ValidationRecipe | undefined> };
}

export async function resolveActiveRecipe(
  deps: RecipeResolverDeps,
  leafRecipe: ValidationRecipe | undefined,
  isDocumentLeaf: boolean,
  valEnv: ValidationExecutionEnvironment,
): Promise<ValidationRecipe | undefined> {
  if (leafRecipe?.checks?.length) return leafRecipe;
  if (isDocumentLeaf) return leafRecipe;
  return deps.validator.inferRecipe(valEnv);
}

export interface RoundDetailsDeps {
  workspaces: { exec(leafId: string, script: string, timeoutMs?: number): Promise<{ stdout: string; exitCode: number }> };
}

export async function readRepoRoundDetails(
  deps: RoundDetailsDeps,
  leafId: string,
): Promise<{ commits?: number; changedFiles?: string[] } | undefined> {
  const out = await deps.workspaces.exec(leafId, buildRepoDetailScript(), 30_000).catch(() => undefined);
  if (!out) return undefined;
  const detail = parseRepoDetail(out.stdout);
  return (detail.commits !== undefined || detail.changedFiles !== undefined) ? detail : undefined;
}

export type ValidationRoundOutcome =
  | { outcome: 'no-recipe' }
  | { outcome: 'passed'; summary: ValidationSummary }
  | { outcome: 'continue'; summary: ValidationSummary; record: ValidationRoundRecord; assessment: LoopProgressAssessment }
  | { outcome: 'halt'; summary: ValidationSummary; record: ValidationRoundRecord; assessment: LoopProgressAssessment };

export interface RunValidationRoundDeps {
  validator: {
    inferRecipe(env: ValidationExecutionEnvironment): Promise<ValidationRecipe | undefined>;
    validate(recipe: ValidationRecipe, env: ValidationExecutionEnvironment): Promise<ValidationSummary>;
  };
  workspaces: WorkspaceService;
}

export interface RunValidationRoundParams {
  round: number;
  leafId: string;
  leafRecipe: ValidationRecipe | undefined;
  isDocumentLeaf: boolean;
  cwd: string | undefined;
  previousRound: ValidationRoundRecord | undefined;
  maxRounds: number;
  workerStoppedBecause: 'circling' | 'thrashing' | 'silent' | 'budget' | undefined;
}

export async function runValidationRound(
  deps: RunValidationRoundDeps,
  params: RunValidationRoundParams,
): Promise<ValidationRoundOutcome> {
  const valEnv = await buildValidatorEnv(deps.workspaces, params.leafId, { cwd: params.cwd });
  const activeRecipe = await resolveActiveRecipe(deps, params.leafRecipe, params.isDocumentLeaf, valEnv);

  if (!activeRecipe || !activeRecipe.checks?.length) return { outcome: 'no-recipe' };

  const summary = await deps.validator.validate(activeRecipe, valEnv);
  if (summary.passed) {
    console.log(`[WorkerValidatorLoop] leaf ${params.leafId}: Round ${params.round} passed all ${summary.totalChecks} checks!`);
    return { outcome: 'passed', summary };
  }

  const repoDetails = await readRepoRoundDetails(deps, params.leafId);
  const record = recordFromSummary(params.round, summary, repoDetails);
  await writeValidationArtifacts(deps.workspaces, params.leafId, summary, record);

  const assessment = assessLoopProgress(params.previousRound, record, params.maxRounds, params.workerStoppedBecause);

  if (assessment.shouldContinue && assessment.feedbackPrompt) {
    console.log(`[WorkerValidatorLoop] leaf ${params.leafId}: Round ${params.round} failed (${summary.failedChecks} failures), handing back to worker: ${assessment.reason}`);
    return { outcome: 'continue', summary, record, assessment };
  }

  console.warn(`[WorkerValidatorLoop] leaf ${params.leafId}: Loop halted at round ${params.round}: ${assessment.reason}`);
  return { outcome: 'halt', summary, record, assessment };
}
