import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { createDatabase } from '../lib/db-interface.js';
import type { Leaf } from '../lib/leaves.js';
import { WorkspaceService } from '../services/WorkspaceService.js';
import { createModelService } from '../lib/model-wiring.js';
import { runAgentLoop, readStreamedReply } from '../lib/agent-loop.js';
import { McpRegistryService } from '../services/McpRegistryService.js';
import { resolveMcpProbeUrl } from '../lib/mcp-probe-url.js';
import { ToolService } from '../services/ToolService.js';
import { personaWorkspace } from '../lib/persona-scope.js';
import { describeBindings } from '../lib/service-binding.js';
import { describable } from '../lib/binding-resolve.js';
import type { WorkspaceLanguage } from '../lib/workspace-spec.js';
import { GiteaService } from '../services/GiteaService.js';
import { InfrastructureService } from '../services/InfrastructureService.js';
import { ProjectRepoService } from '../services/ProjectRepoService.js';
import { v4 as uuidv4 } from 'uuid';
import { trimTrace } from '../lib/leaf-trace.js';
import type { LeafChecks } from '../lib/leaf-trace.js';
import { redactDeep } from '../lib/redact.js';
import { corpusEndpoints } from '../lib/web-tools-resolver.js';
import type { MemoryEndpoints } from '../lib/memory-index.js';
import { buildModelRequest } from '../lib/model-request.js';
import { UniversalValidatorService, type ValidationSummary } from '../services/UniversalValidatorService.js';
import {
  DEFAULT_MAX_VALIDATION_ROUNDS, VALIDATION_FEEDBACK_FILE, type ValidationRoundRecord,
} from '../lib/worker-validator-loop.js';
import { defaultVerifyCommand } from '../lib/leaf-verify.js';
import { buildWebTools } from '../lib/web-tools-wiring.js';
import { agentRunOptions, wantsWeb } from '../lib/agent-run.js';
import { WorkspaceImageService } from '../services/WorkspaceImageService.js';
import { requireBudget } from '../lib/pack-defaults.js';
import { ranAs } from '../lib/run-provenance.js';
import type { ProgressSample } from '../lib/budget-extension.js';
import { captureEvidence } from '../lib/leaf-evidence.js';

import { buildAttemptContext } from '../lib/leaf-attempt-context.js';
import { classifyLeafRun } from '../lib/leaf-run-classify.js';
import { resolveLeafRepo, resolveLeafBindings } from '../lib/leaf-run-environment.js';
import { assembleLeafTaskContext, MAX_FINDINGS_CHARS } from '../lib/leaf-task-context.js';
import { createMemoryAdmitter, recallLeafMemory } from '../lib/leaf-memory-admit.js';
import { resolveMcpForLeaf } from '../lib/leaf-mcp.js';
import {
  buildOnStepDriver, buildSandboxDriver, buildSaveMemoryDriver, buildExtendBudgetDriver, buildCheckpointDriver,
} from '../lib/leaf-round-drivers.js';
import { runValidationRound } from '../lib/leaf-validation-round.js';
import {
  readLeafFindings, pushLeafBranch, verifyLeafRun, checkLeafArtifacts, decideLeafStatus,
} from '../lib/leaf-run-verdict.js';
import { checkLeafDockerfile } from '../lib/leaf-docker-check.js';
import { extractAndSaveLeafMemories } from '../lib/leaf-memory-extract.js';
import { settleFailedLeaf, settleSucceededLeaf } from '../lib/leaf-run-settle.js';
import { recordLeafFailure, notifyLeafFailure, retryDecisionFor } from '../lib/leaf-run-failure.js';

export interface ExecuteLeafArgs {
  leafId: string;
}

export interface ExecuteLeafResult {
  leafId: string;
  tokensUsed: number;
  summary: string;
}

function beat(note: Record<string, unknown>): void {
  try {
    Context.current().heartbeat(note);
  } catch { /* ignored */ }
}

export async function ExecuteLeafActivity(args: ExecuteLeafArgs): Promise<ExecuteLeafResult> {
  let attemptNumber = 1;

  let runSecrets: (string | undefined)[] = [];
  const secretsInPlay = () => runSecrets;
  try {
    attemptNumber = Context.current().info.attempt;
  } catch { /* ignored */ }

  const db = createDatabase();
  await db.init();
  try {
    const allLeaves = await db.getLeaves();
    const leaf = allLeaves.find((c: Leaf) => c.id === args.leafId);
    if (!leaf) return { leafId: args.leafId, tokensUsed: 0, summary: 'Leaf no longer exists' };

    const priorFailures = leaf.attempts ?? [];

    let diagnosis: string | undefined;
    let selfDiagnosed: 'circling' | 'thrashing' | 'silent' | undefined;
    const context = buildAttemptContext(leaf, priorFailures);

    const currentLeaf = async (): Promise<Leaf | undefined> =>
      (await db.getLeaves()).find((l: Leaf) => l.id === leaf.id);

    try {
      const models = createModelService(db, process.env.JWT_SECRET ?? '');
      const classification = await classifyLeafRun(
        { db, resolveBaseUrl: (ownerId, modelId, packEndpointId) => models.resolveBaseUrl(ownerId, modelId, packEndpointId) },
        leaf,
      );
      const {
        treeOf, treeType, conventions, pack, wantsRepo, producesCode, isDocumentLeaf, outputPath,
        workLanguage, leafRecipe, systemPrompt, provider, baseUrl, apiKey, endpointSource,
      } = classification;
      runSecrets = [apiKey];

      let workspacesCreated = 0;
      let lastProgress: ProgressSample | undefined;

      const infra = new InfrastructureService();
      const gitea = new GiteaService(
        infra,
        process.env.JWT_SECRET ?? '',
        process.env.MANAGEMENT_KUBECONFIG ?? '/tmp/kubeconfig-provisioning-lunorica',
      );
      const projectRepos = new ProjectRepoService(db, gitea, process.env.JWT_SECRET ?? '');

      const { project, checkout, giteaBaseUrl } = await resolveLeafRepo(
        { db, gitea, infra, projectRepos, newId: () => uuidv4() },
        leaf, treeOf, treeType, producesCode, wantsRepo,
      );
      const repos = checkout ? projectRepos : undefined;
      if (checkout) {
        runSecrets = [...runSecrets, checkout.cloneUrl, checkout.tokenName];
      }

      const workspaces = new WorkspaceService(process.env.WORKSPACE_KUBECONFIG);
      await workspaces.destroy(leaf.id).catch(() => undefined);

      const { bindings } = await resolveLeafBindings({ db }, leaf.id, project?.needs ?? [], leaf.ownerId);

      const bindingFilesForSandbox = bindings.length
        ? await workspaces.materializeBindings(bindings).catch((err: Error) => {
          console.warn(`[ExecuteLeafActivity] ${leaf.id}: could not read binding credentials: ${err.message}`);
          return [];
        })
        : [];

      const sandboxSpec = personaWorkspace(
        await new WorkspaceImageService(db).list(leaf.ownerId),
        { leafId: leaf.id, ownerId: leaf.ownerId },
        {
          language: project?.language ?? treeType?.language,
          bindings,
          files: bindingFilesForSandbox,
          ...(treeType?.egress ? { egress: treeType.egress } : {}),
          ...(treeType?.env ? { env: treeType.env } : {}),
          ...(wantsRepo ? { requires: ['git'], checkout: true } : {}),
        },
      );
      await workspaces.create(sandboxSpec);
      if (bindings.length) {
        console.log(`[ExecuteLeafActivity] ${leaf.id}: bound ${bindings.map((b) => b.name).join(', ')}`);
      }
      workspacesCreated++;

      try {
        const requireSources = treeType?.requireSources !== false;
        const defaultBranch = project?.defaultBranch || 'main';

        const { taskContext, branchName } = await assembleLeafTaskContext(
          { workspaces },
          { leaf, allLeaves, baseContext: context, checkout, giteaBaseUrl, project, leafRecipe, outputPath, wantsRepo, pack },
        );

        let endsOnce: Promise<MemoryEndpoints> | undefined;
        const memoryEndpoints = () => (endsOnce ??= corpusEndpoints(db, leaf.ownerId));

        const ask = async (prompt: string) => {
          const body = buildModelRequest({
            turn: 'tool-turn',
            ...(pack?.sampling ? { sampling: pack.sampling } : {}),
            ...(provider.kind ? { kind: provider.kind } : {}),
            messages: [{ role: 'user', content: prompt }],
            stream: true,
            maxTokens: 600,
            ...(provider.model ? { model: provider.model } : {}),
            think: false,
          }).body;

          const res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
            body: JSON.stringify(body),
          });
          if (!res.ok) throw new Error(`model returned ${res.status}`);

          const reply = await readStreamedReply(res as never);
          return (reply.content ?? '').trim() || (reply.reasoning ?? '').trim();
        };

        const admit = createMemoryAdmitter({ db, ownerId: leaf.ownerId, leafId: leaf.id, memoryEndpoints, ask });
        const recalled = await recallLeafMemory({ db, memoryEndpoints }, leaf, project?.id);
        const memoryContext = recalled.context;

        const mcpRegistry = new McpRegistryService(db, leaf.ownerId, (name: string) => resolveMcpProbeUrl(name));

        let currentTaskContext = taskContext;
        let validationRound = 1;
        const maxValidationRounds = (leafRecipe || producesCode) ? DEFAULT_MAX_VALIDATION_ROUNDS : 1;
        let previousRoundRecord: ValidationRoundRecord | undefined;
        let loopSuccess = false;
        let finalValidationSummary: ValidationSummary | undefined;

        let lastRunResult: any = { succeeded: false, tokensUsed: 0, completionTokensUsed: 0, trace: [] };
        let totalTokensUsed = 0;
        let totalCompletionTokensUsed = 0;
        const combinedTrace: any[] = [];

        const validator = new UniversalValidatorService();

        while (validationRound <= maxValidationRounds) {
          beat({ phase: 'agent', round: validationRound });
          const roundForBeat = validationRound;
          const singleRun = await runAgentLoop({
            catalogue: await new ToolService(db).schemas(leaf.ownerId, pack?.tools),
            runtime: {
              db,
              userId: leaf.ownerId,
              branchId: leaf.branchId,
              ...(repos ? { projects: repos } : {}),
              mcpRegistry,
            },
            images: await new WorkspaceImageService(db).list(leaf.ownerId),
            ...(pack?.sampling ? { sampling: pack.sampling } : {}),
            baseUrl,
            apiKey,
            model: provider.model,
            ...(provider.kind ? { kind: provider.kind } : {}),
            ...(treeType?.language ? { language: treeType.language as WorkspaceLanguage } : {}),
            captureTrace: true,
            onStep: buildOnStepDriver(
              { db }, leaf, secretsInPlay,
              (step) => beat({ phase: 'agent', step: step.step, tokensUsed: step.tokens, round: roundForBeat }),
            ),
            ...agentRunOptions(pack?.budget ?? await requireBudget(db), pack, {
              taskContext: currentTaskContext,
              ...(() => {
                const provenance = ranAs(pack, { id: provider.id, source: endpointSource });
                return provenance ? { ranAs: provenance } : {};
              })(),
              ...(systemPrompt ? { systemPrompt } : {}),
              sandboxSpec,
              ...(provider.contextTokens ? { contextTokens: provider.contextTokens } : {}),
              ...(memoryContext ? { memoryContext } : {}),
              ...(project || bindings.length ? { bindingsContext: describeBindings(bindings.map(describable)) } : {}),
              ...(wantsWeb(pack) ? { web: await buildWebTools(db, leaf.ownerId) } : {}),
              ...(await resolveMcpForLeaf({ registry: mcpRegistry }, pack, leaf, treeType?.egress)),
              ...(leafRecipe ? { validationRecipe: leafRecipe } : {}),
              saveMemory: buildSaveMemoryDriver(admit, leaf, secretsInPlay),
              sandbox: buildSandboxDriver(workspaces, leaf.id),
              extendBudget: buildExtendBudgetDriver(
                { workspaces, db },
                {
                  leaf, checkout: Boolean(checkout), branchName, defaultBranch, outputPath, conventions,
                  requireSources,
                  progress: { get: () => lastProgress, set: (s) => { lastProgress = s; } },
                  onBeat: (step) => beat({ phase: 'extend-probe', step, round: roundForBeat }),
                },
              ),
              checkpoint: buildCheckpointDriver(
                { workspaces, db, currentLeaf },
                {
                  leaf, checkout: Boolean(checkout), branchName, defaultBranch, outputPath, requireSources,
                  progress: { get: () => lastProgress, set: (s) => { lastProgress = s; } },
                  onBeat: (number) => beat({ phase: 'checkpoint', number }),
                },
              ),
            }),
          });

          lastRunResult = singleRun;
          totalTokensUsed += (singleRun.tokensUsed ?? 0);
          totalCompletionTokensUsed += (singleRun.completionTokensUsed ?? 0);
          if (singleRun.trace?.length) combinedTrace.push(...singleRun.trace);

          if (maxValidationRounds === 1) {
            loopSuccess = singleRun.succeeded;
            break;
          }

          beat({ phase: 'validating', round: validationRound });
          const roundResult = await runValidationRound(
            { validator, workspaces },
            {
              round: validationRound, leafId: leaf.id, leafRecipe, isDocumentLeaf,
              cwd: checkout && branchName ? '/work/repo' : undefined,
              previousRound: previousRoundRecord, maxRounds: maxValidationRounds,
              workerStoppedBecause: singleRun.stoppedBecause,
            },
          );

          if (roundResult.outcome === 'no-recipe') {
            loopSuccess = singleRun.succeeded;
            break;
          }
          if (roundResult.outcome === 'passed') {
            loopSuccess = true;
            finalValidationSummary = roundResult.summary;
            break;
          }

          finalValidationSummary = roundResult.summary;
          if (roundResult.outcome === 'continue') {
            previousRoundRecord = roundResult.record;
            currentTaskContext = [
              taskContext,
              '',
              `The project Validator tested your work. Detailed test results and logs have been recorded in \`${VALIDATION_FEEDBACK_FILE}\` in your workspace.`,
              `Fix the failing checks and verify they pass before calling finish:`,
              '',
              roundResult.assessment.feedbackPrompt!,
            ].join('\n');
            validationRound++;
          } else {
            loopSuccess = false;
            break;
          }
        }

        const run = {
          ...lastRunResult,
          tokensUsed: totalTokensUsed,
          completionTokensUsed: totalCompletionTokensUsed,
          trace: combinedTrace,
          succeeded: loopSuccess,
        };

        diagnosis = run.summary;
        if (run.stoppedBecause && run.stoppedBecause !== 'budget') selfDiagnosed = run.stoppedBecause;

        const spent = {
          ...(leaf.usage ?? {}),
          tokens: (leaf.usage?.tokens ?? 0) + (run.tokensUsed ?? 0),
          completionTokens: (leaf.usage?.completionTokens ?? 0) + (run.completionTokensUsed ?? 0),
          workspaces: (leaf.usage?.workspaces ?? 0) + workspacesCreated,
        };

        if (run.trace?.length) {
          const fitted = trimTrace(run.trace);
          await db.saveLeafTrace({
            id: leaf.id,
            ownerId: leaf.ownerId,
            branchId: leaf.branchId,
            steps: redactDeep(fitted.steps, secretsInPlay()),
            ...(fitted.trimmed ? { trimmed: true } : {}),
            totalSteps: run.trace.length,
            tokensUsed: run.tokensUsed,
            ...(run.checkpoints?.length ? { checkpoints: run.checkpoints } : {}),
            createdAt: new Date().toISOString(),
          }).catch((err) => {
            console.warn(`[ExecuteLeafActivity] leaf ${leaf.id}: could not store trace: ${err?.message}`);
          });
        }

        const findings = await readLeafFindings(workspaces, leaf.id, outputPath);

        const verifyCommand = producesCode ? (leaf.verifyCommand?.trim() || defaultVerifyCommand(workLanguage)) : '';
        const declaredVerify = Boolean((producesCode && leaf.verifyCommand?.trim()) || leafRecipe || finalValidationSummary);

        beat({ phase: 'verify' });
        const verify = await verifyLeafRun(
          { validator, workspaces },
          {
            leafId: leaf.id, outputPath, findings, requireSources, finalValidationSummary, leafRecipe,
            isDocumentLeaf, cwd: checkout && branchName ? '/work/repo' : undefined, verifyCommand, workLanguage,
          },
        );

        beat({ phase: 'push' });
        const pushedBranch = await pushLeafBranch(workspaces, leaf.id, Boolean(checkout), branchName);

        if (wantsRepo && leaf.expects?.length) beat({ phase: 'artifacts' });
        const artifacts = await checkLeafArtifacts(workspaces, leaf.id, wantsRepo, leaf.expects, defaultBranch, conventions);

        const dockerProblems = producesCode ? await checkLeafDockerfile(workspaces, leaf.id) : '';

        const { combined, settled } = decideLeafStatus({
          leafId: leaf.id,
          outputPath,
          verifyOutcome: verify.outcome,
          declaredVerify,
          pushedBranch,
          artifactsOutcome: artifacts.outcome,
          dockerProblems,
          claimed: run.succeeded,
        });

        const checks: LeafChecks = {
          verify: { ...(verifyCommand ? { command: verifyCommand } : {}), outcome: verify.outcome },
          artifacts: { outcome: artifacts.outcome, ...(artifacts.missing.length ? { missing: artifacts.missing } : {}) },
          ...(dockerProblems ? { docker: { problems: true } } : {}),
          ...(outputPath ? { findings: { outcome: verify.outcome } } : {}),
          combined,
          settled,
        };

        try {
          beat({ phase: 'evidence' });
          const evidence = await captureEvidence({
            workspaces,
            leafId: leaf.id,
            ...(checkout && branchName ? { base: defaultBranch } : {}),
            ...(leaf.expects?.length ? { expects: leaf.expects } : {}),
            ...(verify.output ? { verifyOutput: verify.output } : {}),
            ...(findings.trim() ? { findings: findings.slice(0, MAX_FINDINGS_CHARS) } : {}),
          });
          await db.saveLeafEvidence(leaf.id, redactDeep(evidence, secretsInPlay()));
        } catch (err: any) {
          console.warn(`[ExecuteLeafActivity] leaf ${leaf.id}: could not capture evidence: ${err?.message}`);
        }

        await extractAndSaveLeafMemories(
          { db, workspaces, admit },
          {
            leaf: { ...leaf, ...(project ? { projectId: project.id } : {}) },
            summary: run.summary,
            succeeded: settled === 'succeeded',
            missingArtifacts: artifacts.missing,
            ...(verify.output ? { verifyOutput: verify.output } : {}),
          },
        );

        if (settled === 'failed') {
          if (checkout) beat({ phase: 'repo-state' });
          return await settleFailedLeaf(
            { workspaces, db, currentLeaf },
            {
              leafId: leaf.id,
              checkout: Boolean(checkout),
              pushedBranch,
              project,
              findings,
              spent,
              runSucceeded: run.succeeded,
              runSummary: run.summary,
              verify,
              artifactsOutcome: artifacts.outcome,
              artifactsMissing: artifacts.missing,
              dockerProblems,
              verifyCommand,
            },
          );
        }

        beat({ phase: 'merge' });
        return await settleSucceededLeaf(
          { workspaces, db, currentLeaf },
          {
            leafId: leaf.id,
            pushedBranch,
            combined,
            dockerProblems,
            spent,
            checks,
            runSummary: run.summary,
            runTokensUsed: run.tokensUsed,
            project,
            findings,
            secretsInPlay,
          },
        );
      } finally {
        await workspaces.destroy(leaf.id).catch(() => undefined);
        if (repos && checkout) await repos.revokeCheckout(leaf.ownerId, checkout.tokenName).catch(() => undefined);
      }
    } catch (err: any) {
      const after = await currentLeaf().catch(() => undefined);
      const produced = Boolean(after?.outputBranch || after?.findings?.trim());

      const { attempts, latest } = await recordLeafFailure(
        { db, currentLeaf },
        {
          attemptNumber,
          priorFailures,
          errMessage: String(err?.message ?? err),
          produced,
          diagnosis,
          secretsInPlay,
        },
      );

      await notifyLeafFailure(
        { db },
        {
          leafId: args.leafId,
          branchId: latest?.branchId ?? leaf.branchId,
          leafTitle: latest?.title ?? leaf.title,
          errMessage: String((err as Error)?.message ?? err),
          attemptCount: attempts.length,
        },
      );

      const decision = retryDecisionFor({
        errMessage: String((err as Error)?.message ?? err),
        selfDiagnosed,
        produced,
        priorFailures,
      });

      if (decision.kind === 'nonRetryable') {
        const label = decision.type === 'SelfDiagnosedStop'
          ? `stopped itself (${selfDiagnosed}) — not retrying`
          : 'two attempts produced nothing — not retrying';
        console.warn(`[ExecuteLeafActivity] leaf ${args.leafId}: ${label}`);
        throw ApplicationFailure.nonRetryable(decision.message, decision.type);
      }

      throw err;
    }
  } finally {
    await db.close();
  }
}
