import type { WorkspaceService } from '../services/WorkspaceService.js';
import type { WorkspaceLanguage } from './workspace-spec.js';
import type { ValidationRecipe } from './tree-types.js';
import type { ValidationSummary, ValidationExecutionEnvironment } from '../services/UniversalValidatorService.js';
import type { FileConventions } from './tree-type-conventions.js';
import {
  buildVerifyScript, parseVerifyResult, decideStatus, evidenceOf,
  type VerifyResult, type VerifyOutcome,
} from './leaf-verify.js';
import {
  buildArtifactCheckScript, parseArtifactResult, combineVerification, type ArtifactResult, type ArtifactOutcome,
} from './leaf-artifacts.js';
import { assessFindings } from './research-verify.js';
import { buildPushScript, parsePushedBranch } from './leaf-checkout.js';
import { resolveActiveRecipe } from './leaf-validation-round.js';
import { buildValidatorEnv } from './validator-env.js';

export async function readLeafFindings(
  workspaces: { readFile(leafId: string, path: string): Promise<string> },
  leafId: string,
  outputPath: string | undefined,
): Promise<string> {
  if (!outputPath) return '';
  return workspaces.readFile(leafId, outputPath).catch(() => '');
}

export async function pushLeafBranch(
  workspaces: { exec(leafId: string, script: string, timeoutMs?: number, args?: string[]): Promise<{ stdout: string }> },
  leafId: string,
  checkout: boolean,
  branchName: string | undefined,
): Promise<string | undefined> {
  if (!checkout || !branchName) return undefined;
  const pushed = await workspaces.exec(leafId, buildPushScript(branchName), 120_000, [branchName]).catch(() => undefined);
  const confirmed = pushed ? parsePushedBranch(pushed.stdout) : undefined;
  if (!confirmed) {
    console.warn(`[leaf-run-verdict] leaf ${leafId} pushed nothing to ${branchName}`);
  }
  return confirmed;
}

export interface VerifyLeafRunDeps {
  validator: {
    inferRecipe(env: ValidationExecutionEnvironment): Promise<ValidationRecipe | undefined>;
    validate(recipe: ValidationRecipe, env: ValidationExecutionEnvironment): Promise<ValidationSummary>;
  };
  workspaces: WorkspaceService;
}

export interface VerifyLeafRunParams {
  leafId: string;
  outputPath: string | undefined;
  findings: string;
  requireSources: boolean;
  finalValidationSummary: ValidationSummary | undefined;
  leafRecipe: ValidationRecipe | undefined;
  isDocumentLeaf: boolean;
  cwd: string | undefined;
  verifyCommand: string | undefined;
  workLanguage: WorkspaceLanguage | undefined;
}

export async function verifyLeafRun(deps: VerifyLeafRunDeps, params: VerifyLeafRunParams): Promise<VerifyResult> {
  const {
    leafId, outputPath, findings, requireSources, finalValidationSummary, leafRecipe, isDocumentLeaf,
    cwd, verifyCommand, workLanguage,
  } = params;

  if (outputPath) {
    const verdict = assessFindings(findings, outputPath, requireSources);
    return { outcome: verdict.outcome, output: verdict.reason };
  }

  if (finalValidationSummary) {
    return { outcome: finalValidationSummary.passed ? 'passed' : 'failed', output: finalValidationSummary.diagnosticReport };
  }

  const valEnv = await buildValidatorEnv(deps.workspaces, leafId, { cwd });
  const activeRecipe = await resolveActiveRecipe(deps, leafRecipe, isDocumentLeaf, valEnv);

  if (activeRecipe?.checks?.length) {
    const summary = await deps.validator.validate(activeRecipe, valEnv).catch(() => undefined);
    return summary
      ? { outcome: summary.passed ? 'passed' : 'failed', output: summary.diagnosticReport }
      : { outcome: 'unverified', output: '' };
  }

  if (verifyCommand) {
    return deps.workspaces
      .exec(leafId, buildVerifyScript(verifyCommand, workLanguage), 300_000)
      .then((r) => parseVerifyResult(r.stdout))
      .catch(() => ({ outcome: 'unverified' as const, output: '' }));
  }

  return { outcome: 'unverified', output: '' };
}

export async function checkLeafArtifacts(
  workspaces: { exec(leafId: string, script: string, timeoutMs?: number): Promise<{ stdout: string }> },
  leafId: string,
  wantsRepo: boolean,
  expects: string[] | undefined,
  defaultBranch: string,
  conventions: FileConventions | undefined,
): Promise<ArtifactResult> {
  if (!(wantsRepo && expects?.length)) return { outcome: 'none', missing: [], moved: [] };

  const result = await workspaces
    .exec(leafId, buildArtifactCheckScript(expects, defaultBranch, conventions), 60_000)
    .then((r) => parseArtifactResult(r.stdout))
    .catch(() => ({ outcome: 'unknown' as const, missing: [], moved: [] }));

  if (result.moved.length) {
    console.log(`[leaf-run-verdict] leaf ${leafId}: declared artifacts found elsewhere — ${result.moved.join(', ')}`);
  }
  if (result.outcome === 'stale') {
    console.log(`[leaf-run-verdict] leaf ${leafId}: declared artifacts already present and unchanged — ${result.missing.join(', ')}`);
  }
  return result;
}

export function decideLeafStatus(params: {
  leafId: string;
  outputPath: string | undefined;
  verifyOutcome: VerifyOutcome;
  declaredVerify: boolean;
  pushedBranch: string | undefined;
  artifactsOutcome: ArtifactOutcome;
  dockerProblems: string;
  claimed: boolean;
}): { earned: VerifyOutcome; combined: 'passed' | 'failed' | 'unverified'; settled: 'succeeded' | 'failed' } {
  const earned = params.outputPath
    ? params.verifyOutcome
    : evidenceOf(params.verifyOutcome, { declaredCommand: params.declaredVerify, changed: Boolean(params.pushedBranch) });

  if (earned !== params.verifyOutcome) {
    console.warn(`[leaf-run-verdict] leaf ${params.leafId}: default suite passed but nothing was committed — recording unverified, not verified`);
  }

  const combined = combineVerification(earned, params.artifactsOutcome);
  const settled = params.dockerProblems ? 'failed' : decideStatus(params.claimed, combined);
  return { earned, combined, settled };
}
