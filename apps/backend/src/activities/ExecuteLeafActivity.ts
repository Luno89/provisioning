import { Context } from '@temporalio/activity';
import { visibleAppSpecs } from '../lib/app-spec.js';
import { ApplicationFailure } from '@temporalio/common';
import { createDatabase } from '../lib/db-interface.js';
import { failureContext, type Branch, type Leaf, type LeafAttempt } from '../lib/leaves.js';
import { WorkspaceService } from '../services/WorkspaceService.js';
import { createModelService } from '../lib/model-wiring.js';
import { runAgentLoop } from '../lib/agent-loop.js';
import { checkDockerfile, describeDockerfileProblems } from '../lib/dockerfile-check.js';
import { McpRegistryService } from '../services/McpRegistryService.js';
import { resolveForPersona, mcpGaps } from '../lib/mcp-registry.js';
import { toLoopTools, routeCall } from '../lib/mcp-tools.js';
import { resolveMcpProbeUrl } from '../lib/mcp-probe-url.js';
import { resolvePrompt } from '../lib/personas.js';
import { packForLeaf } from '../lib/packs.js';
import { ToolService } from '../services/ToolService.js';
import { flattenPersona, usesRepo, personaWorkspace, allowedTools } from '../lib/persona-scope.js';
import {
  prepareInputs, buildInputIndex, buildInlineInputs, REQUIRED_TOOL,
} from '../lib/dependency-inputs.js';
import { resolveBindings, describable, type ResolvedBinding } from '../lib/binding-resolve.js';
import { describeBindings } from '../lib/service-binding.js';
import type { WorkspaceLanguage } from '../lib/workspace-spec.js';
import { WORKSPACE_MOUNT } from '../lib/workspace-spec.js';
import { GiteaService } from '../services/GiteaService.js';
import { InfrastructureService } from '../services/InfrastructureService.js';
import { ProjectRepoService } from '../services/ProjectRepoService.js';
import { v4 as uuidv4 } from 'uuid';
import type { ProjectMetadata } from '../lib/types.js';
import { resolveLeafProject } from '../lib/leaf-project.js';
import { primaryProjectId, withProject } from '../lib/trees.js';
import { nodeBaseImage } from '../lib/project-templates.js';
import { resolveTreeType, renderStarterFiles } from '../lib/tree-types.js';
import { conventionsOf } from '../lib/tree-type-conventions.js';
import { trimTrace } from '../lib/leaf-trace.js';
import {
  branchNameFor, baseBranchesFor, buildCheckoutScript, buildPushScript, parsePushedBranch,
  buildRepoStateScript, summariseRepoState, buildMergeScript, parseMergeResult,
  checkpointPath, buildCheckpointScript, parseCheckpointResult, buildProgressScript, parseProgress,
} from '../lib/leaf-checkout.js';
import { buildCheckpointArtifact } from '../lib/leaf-checkpoint.js';
import { captureEvidence } from '../lib/leaf-evidence.js';
import type { LeafChecks } from '../lib/leaf-trace.js';
import {
  compareProgress, decideExtension, refusalReason, type ProgressSample,
} from '../lib/budget-extension.js';
import { redactDeep, redactSecrets } from '../lib/redact.js';
import {
  defaultVerifyCommand, buildVerifyScript, parseVerifyResult, decideStatus, evidenceOf,
  type VerifyResult,
} from '../lib/leaf-verify.js';
import {
  buildArtifactCheckScript, parseArtifactResult, combineVerification,
} from '../lib/leaf-artifacts.js';
import { recallMemories, recallQuery, markUsed } from '../lib/memory-recall.js';
import { corpusEndpoints } from '../lib/web-tools-resolver.js';
import { searchMemories, indexMemories, bodyOf, type MemoryEndpoints } from '../lib/memory-index.js';
import { admitMemory, type Decision } from '../lib/memory-decide.js';
import type { MemoryItem } from '../lib/memory-store.js';
import { buildModelRequest } from '../lib/model-request.js';
import { readStreamedReply } from '../lib/agent-loop.js';
import { buildFailureNotice, withNotice } from '../lib/branch-notice.js';
import { UniversalValidatorService, type ValidationSummary } from '../services/UniversalValidatorService.js';
import {
  assessLoopProgress, recordFromSummary, writeValidationArtifacts,
  VALIDATION_FEEDBACK_FILE, DEFAULT_MAX_VALIDATION_ROUNDS, type ValidationRoundRecord,
} from '../lib/worker-validator-loop.js';
import {
  MAX_LEAF_ATTEMPTS, statusAfterFailure, rootLeaf, aggregateUsage, barrenStreak,
} from '../lib/leaves.js';
import { extractLeafMemories, supersede } from '../lib/leaf-memory.js';
import { assessFindings } from '../lib/research-verify.js';
import { WEB_TOOL_NAMES } from '../lib/leaf-tools.js';
import { buildWebTools } from '../lib/web-tools-wiring.js';
import { agentRunOptions, wantsWeb, wantsMcp } from '../lib/agent-run.js';
import { withBuiltIns } from '../lib/ownership.js';
import { WorkspaceImageService } from '../services/WorkspaceImageService.js';
import { requireBudget } from '../lib/pack-defaults.js';
import { ranAs } from '../lib/run-provenance.js';

export interface ExecuteLeafArgs {
  leafId: string;
}

export const FINDINGS_PATH = '/work/findings.md';

export const MAX_FINDINGS_CHARS = 20000;

function beat(note: Record<string, unknown>): void {
  try {
    Context.current().heartbeat(note);
  } catch { /* ignored */ }
}

export interface ExecuteLeafResult {
  leafId: string;
  tokensUsed: number;
  summary: string;
}

export function buildLeafContext(leaf: Leaf, priorFailures: LeafAttempt[]): string {
  const parts = [`Task: ${leaf.title}`];
  if (leaf.body) parts.push(leaf.body);

  const failures = failureContext(priorFailures);
  if (failures) parts.push(failures);

  return parts.join('\n\n');
}

async function resolveMcpForLeaf(db: any, pack: any, leaf: any): Promise<Record<string, unknown>> {
  const wanted = [...new Set([...wantsMcp(pack), ...(leaf?.mcp ?? [])])];
  if (!wanted.length) return {};

  try {
    const registry = new McpRegistryService(db, leaf.ownerId, (name: string) => resolveMcpProbeUrl(name));
    const { servers, missing } = resolveForPersona(wanted, await registry.listWithTools());

    if (missing.length) {
      console.warn(`[ExecuteLeafActivity] leaf ${leaf.id}: pack named MCP servers that are not running — ${missing.join(', ')}`);
    }
    for (const gap of mcpGaps(servers, pack?.workspace?.egress, (s: any) => s.deploymentName ?? s.name)) {
      console.warn(`[ExecuteLeafActivity] leaf ${leaf.id}: ${gap}`);
    }

    const usable = servers.filter((s) => s.tools.length && !s.unreachable);
    if (!usable.length) return {};

    const remoteTools = usable.flatMap((s) => toLoopTools(s.name, s.tools));
    return {
      remoteTools,
      remoteToolNames: remoteTools.map((t) => t.function.name),
      callRemote: async (name: string, args: Record<string, unknown>) => {
        const route = routeCall(name, usable.map((s) => s.name));
        const server = route ? usable.find((s) => s.name === route.server) : undefined;
        if (!route || !server) return undefined;
        return registry.call(server, route.tool, args);
      },
    };
  } catch (err: any) {
    console.warn(`[ExecuteLeafActivity] leaf ${leaf.id}: could not resolve MCP servers — ${String(err?.message ?? err).slice(0, 200)}`);
    return {};
  }
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
    const context = buildLeafContext(leaf, priorFailures);

    const currentLeaf = async (): Promise<Leaf | undefined> =>
      (await db.getLeaves()).find((l: Leaf) => l.id === leaf.id);

    try {
      const models = createModelService(db, process.env.JWT_SECRET ?? '');

      const profile = await db.getHarnessProfile(leaf.ownerId);
      const ownPersonas = withBuiltIns(await db.getPersonas(), leaf.ownerId, (p) => p.name);

      const ownPacks = withBuiltIns(await db.getPersonaPacks(), leaf.ownerId, (p) => p.slug);
      const pack = packForLeaf(ownPacks, leaf, profile?.packId);
      const wanted = pack?.personaId;
      const assigned = wanted ? ownPersonas.find((p) => p.id === wanted) : undefined;
      const persona = assigned ? flattenPersona(assigned, ownPersonas) : null;
      const wantsRepo = usesRepo(pack);

      const branchOfLeaf = (await db.getBranches()).find((b) => b.id === leaf.branchId);
      const treeOf = branchOfLeaf?.treeId
        ? (await db.getTrees()).find((t) => t.id === branchOfLeaf.treeId)
        : undefined;
      const treeType = await resolveTreeType(db, leaf.ownerId, treeOf?.type);
      const conventions = conventionsOf(treeType);

      const producesCode = Boolean(
        (treeType && (treeType.produces === 'service' || treeType.validationRecipe || (treeType.files?.length ?? 0) > 0)) ||
        (!treeType && !pack?.workspace?.output) ||
        leaf.validationContract ||
        leaf.projectId ||
        (treeOf?.projectIds?.length ?? 0) > 0 ||
        usesRepo(pack)
      );

      const workLanguage = (pack?.workspace?.language ?? treeType?.language) as WorkspaceLanguage | undefined;
      const declaredOutput = pack?.workspace?.output;
      const outputPath = declaredOutput;

      const systemPrompt = resolvePrompt(persona);
      const chosen = undefined;
      const { provider, baseUrl, apiKey, source: endpointSource } = await models.resolveBaseUrl(leaf.ownerId, chosen, pack?.model?.endpointId);
      runSecrets = [apiKey];

      let branchName: string | undefined;
      let repos: ProjectRepoService | undefined;
      let checkout: { cloneUrl: string; tokenName: string; username: string } | undefined;
      let gitea0 = '';
      let workspacesCreated = 0;
      let lastProgress: ProgressSample | undefined;
      const infra = new InfrastructureService();
      const gitea = new GiteaService(
        infra,
        process.env.JWT_SECRET ?? '',
        process.env.MANAGEMENT_KUBECONFIG ?? '/tmp/kubeconfig-provisioning-lunorica',
      );
      let project: ProjectMetadata | undefined;
      if (!wantsRepo) {
        console.log(`[ExecuteLeafActivity] leaf ${leaf.id}: persona writes no files, so no checkout`);
      } else try {
        const projectRepos = new ProjectRepoService(db, gitea, process.env.JWT_SECRET ?? '');
        project = await resolveLeafProject({
          db,
          ...(treeOf ? { treeProjectId: primaryProjectId(treeOf) } : {}),
          ensureAccount: (ownerId) => projectRepos.ensureAccountFor(ownerId),
          repoExists: (username, name) => gitea.getRepo(username, name).then(() => true, () => false),
          createRepo: (username, name) => gitea.createRepoForUser(username, name, {
            description: `Koala request ${leaf.branchId.slice(0, 8)}`,
          }).then(() => undefined),
          newId: () => uuidv4(),
        }, leaf);
        repos = projectRepos;
        gitea0 = gitea.internalBaseUrl;
        checkout = await repos.checkoutCredential(leaf.ownerId, project);
        runSecrets = [...runSecrets, checkout.cloneUrl, checkout.tokenName];

        try {
          const files = renderStarterFiles(treeType?.files ?? [], {
            projectName: project.giteaRepo,
            registryHost: nodeBaseImage(),
          });
          if (files.length) {
            const written = await gitea.seedTemplate(project.giteaOwner, project.giteaRepo, files);
            if (written.length) {
              console.log(`[ExecuteLeafActivity] seeded ${project.giteaRepo} from the ${treeType?.label ?? treeOf?.type} template: ${written.join(', ')}`);
            }
          }
        } catch (err) {
          console.warn(`[ExecuteLeafActivity] could not seed ${project.giteaRepo}: ${(err as Error).message}`);
        }

        if (producesCode) try {
          const nodeIp = await infra.runKubectl(
            ['get', 'nodes', '-o', 'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}'],
            '/tmp/kubeconfig-provisioning-lunorica',
          );
          const wired = await projectRepos.ensureShippable(project, nodeIp, process.env.PORT || 3001, process.env.JWT_SECRET ?? '');
          if (wired.problems.length) {
            console.warn(`[ExecuteLeafActivity] leaf ${leaf.id}: project not fully shippable — ${wired.problems.join('; ')}`);
          }
        } catch (err) {
          console.warn(`[ExecuteLeafActivity] leaf ${leaf.id}: could not wire ${project.name} for builds: ${(err as Error).message}`);
        }

        if (treeOf) {
          const fresh = (await db.getTrees()).find((t) => t.id === treeOf.id);
          if (fresh) await db.saveTree(withProject(fresh, project.id));
        }
      } catch (err) {
        console.warn(`[ExecuteLeafActivity] no repository for leaf ${leaf.id}, work will not persist: ${(err as Error).message}`);
        project = undefined;
        repos = undefined;
        checkout = undefined;
      }

      const workspaces = new WorkspaceService(process.env.WORKSPACE_KUBECONFIG);
      await workspaces.destroy(leaf.id).catch(() => undefined);
      let bindings: ResolvedBinding[] = [];
      try {
        const needs = project?.needs ?? [];
        if (needs.length && project) {
          const dynamicTypes = await db.getBindingTypes().catch(() => []);
          const resolution = resolveBindings(
            needs,
            await db.getDeployments(),
            visibleAppSpecs(await db.getAppSpecs(), leaf.ownerId),
            leaf.ownerId,
            { dynamicTypes },
          );
          bindings = resolution.bindings;
          for (const problem of resolution.problems) {
            console.warn(`[ExecuteLeafActivity] ${leaf.id}: binding not available — ${problem}`);
          }
        }
      } catch (err) {
        console.warn(`[ExecuteLeafActivity] ${leaf.id}: could not resolve bindings: ${(err as Error).message}`);
      }

      const bindingFilesForSandbox = bindings.length
        ? await workspaces.materializeBindings(bindings).catch((err: Error) => {
          console.warn(`[ExecuteLeafActivity] ${leaf.id}: could not read binding credentials: ${err.message}`);
          return [];
        })
        : [];

      const sandboxSpec = personaWorkspace(
        await new WorkspaceImageService(db).list(leaf.ownerId),
        pack,
        { leafId: leaf.id, ownerId: leaf.ownerId },
        {
          language: project?.language ?? treeType?.language,
          bindings,
          files: bindingFilesForSandbox,
          ...(wantsRepo ? { requires: ['git'], checkout: true } : {}),
        },
      );
      await workspaces.create(sandboxSpec);
      if (bindings.length) {
        console.log(`[ExecuteLeafActivity] ${leaf.id}: bound ${bindings.map((b) => b.name).join(', ')}`);
      }
      workspacesCreated++;

      try {
        let taskContext = context;
        if (checkout && project) {
          branchName = branchNameFor(leaf.id);
          const baseBranches = [
            ...(leaf.outputBranch ? [leaf.outputBranch] : []),
            ...baseBranchesFor(leaf, allLeaves),
          ];
          const cloned = await workspaces.exec(
            leaf.id,
            buildCheckoutScript({
              cloneUrl: checkout.cloneUrl,
              cleanUrl: `${gitea0}/${project.giteaOwner}/${project.giteaRepo}.git`,
              branch: branchName,
              baseBranches,
            }),
            180_000,
            [checkout.cloneUrl, branchName, `${gitea0}/${project.giteaOwner}/${project.giteaRepo}.git`],
          );
          if (cloned.exitCode !== 0) {
            throw new Error(`Could not clone ${project.giteaOwner}/${project.giteaRepo}: ${cloned.stderr.slice(0, 300)}`);
          }
          taskContext = [
            context,
            '',
            `The repository ${project.giteaOwner}/${project.giteaRepo} is cloned at /work/repo, on a new branch "${branchName}".`,
            ...(leaf.outputBranch
              ? ['A PREVIOUS ATTEMPT at this same task already committed here. Read what is there first and continue from it — do not start over.']
              : []),
            ...(baseBranchesFor(leaf, allLeaves).length
              ? [`It also contains the work of the leaves this one depends on. Build on what is there rather than starting over.`]
              : []),
            'Work there. Commit your changes with git as you go. Do NOT change the git remote or credentials —',
            'they are already configured. When you are done, push with `git push -u origin HEAD`.',
            'Runtime Environment & Secrets: Your application runs in a container where configuration and credentials are provided as standard environment variables (e.g. process.env.<NAME>, os.environ[\'<NAME>\']). Read all secrets from environment variables with sensible defaults or clean error handling on missing values. Never hardcode sensitive tokens.',
            ...(leaf.validationContract || treeType?.validationRecipe
              ? [
                  '',
                  '## Validation & Quality Gate',
                  'The Validator will independently evaluate your work using the project ValidationRecipe.',
                  'You can call the `validate_progress` tool at any time during execution to test your changes against these checks.',
                  'When you finish, the Validator will test your work. If any checks fail, you will be handed back the exact diagnostic errors for another refinement iteration.',
                ]
              : []),
          ].join('\n');

          const priorCheckpoint = await workspaces
            .readFile(leaf.id, `/work/repo/${checkpointPath(leaf.id)}`)
            .catch(() => '');
          if (priorCheckpoint.trim()) {
            taskContext = [
              taskContext,
              '',
              '## WHERE THE LAST ATTEMPT LEFT OFF',
              priorCheckpoint.trim().slice(0, MAX_FINDINGS_CHARS),
            ].join('\n');
          }
        }

        if (outputPath) {
          const preparedInputs = prepareInputs(
            allLeaves
              .filter((l) => (leaf.dependsOn ?? []).includes(l.id) && l.findings?.trim())
              .map((l) => ({ leafId: l.id, title: l.title, findings: l.findings! })),
          );

          const canReadFiles = allowedTools(pack, [REQUIRED_TOOL]).includes(REQUIRED_TOOL);
          let inputsBlock = '';
          if (preparedInputs.length && canReadFiles) {
            const written = await Promise.all(preparedInputs.map((input) =>
              workspaces.writeFile(leaf.id, input.path, input.content)
                .then(() => true)
                .catch((err: Error) => {
                  console.warn(`[ExecuteLeafActivity] ${leaf.id}: could not write ${input.path}: ${err.message}`);
                  return false;
                })));
            const landed = preparedInputs.filter((_, i) => written[i]);
            inputsBlock = [
              buildInputIndex(landed, WORKSPACE_MOUNT),
              ...(landed.length < preparedInputs.length
                ? [buildInlineInputs(preparedInputs.filter((_, i) => !written[i]))]
                : []),
            ].filter(Boolean).join('\n\n');
          } else if (preparedInputs.length) {
            inputsBlock = buildInlineInputs(preparedInputs);
          }

          taskContext = [
            context,
            '',
            'There is no repository here and nothing to commit.',
            `Your answer goes in ${outputPath}. That file IS the deliverable — it is the only thing`,
            'kept when this sandbox is destroyed, and an answer that exists only in your replies is lost.',
            '',
            `WRITE ${outputPath} EARLY, even if it is only an outline, and then keep rewriting it as`,
            'you learn more. A run that spends its whole budget researching and never writes the file has',
            'produced nothing.',
            '',
            'AN OUTLINE IS NOT AN ANSWER. Do not call finish while any section is a heading with nothing',
            'under it, or says "TBD", "TODO" or "to be filled" — that is checked, and it fails the leaf.',
            'Every section must contain what you actually found, in prose.',
            '',
            'Use web_search and fetch_web_page to check what you write rather than answering from memory,',
            'and include the URLs you used — an answer citing no sources fails. Spend no more than about',
            'half your steps searching; the rest belongs to writing.',
            '',
            'This sandbox has NO network access. curl and wget will silently return nothing —',
            'web_search and fetch_web_page are the only way out, and they stop working halfway',
            'through the run so that the second half is spent writing.',
            ...(leaf.findings?.trim()
              ? (wantsRepo && leaf.outputBranch
                ? [
                    '',
                    `A PREVIOUS ATTEMPT already wrote ${outputPath} and pushed it to "${leaf.outputBranch}",`,
                    'which is the branch checked out for you. READ THAT FILE FIRST, then fix what the',
                    'failure above says was wrong with it. Do not start over and do not rewrite it from',
                    'scratch — most of it is right.',
                  ]
                : [
                    '',
                    `A PREVIOUS ATTEMPT wrote this. Start by writing it back to ${outputPath}, then fix`,
                    'what the failure above says was wrong with it. Do not start over.',
                    '',
                    leaf.findings.trim(),
                  ])
              : []),
            ...(inputsBlock ? ['', inputsBlock] : []),
          ].join('\n');
        }

        let endsOnce: Promise<MemoryEndpoints> | undefined;
        const memoryEndpoints = () => (endsOnce ??= corpusEndpoints(db, leaf.ownerId));

        // Always on: it was an override key, and there is no layer left to turn it off from.
        const decideEnabled = true;

        const admit = async (candidate: MemoryItem): Promise<Decision> => {
          const gate = decideEnabled
            ? {
              neighbours: async (m: MemoryItem) => {
                const ends = await memoryEndpoints();
                const hits = await searchMemories(ends, bodyOf(m), { ownerId: leaf.ownerId });
                const stored = await db.getMemories(leaf.ownerId);
                const byId = new Map(stored.map((x: MemoryItem) => [x.id, x]));
                const found = hits
                  .map((h) => byId.get(h.id))
                  .filter((x): x is MemoryItem => x !== undefined);
                return found.filter((x) => x.category === m.category
                  && !x.invalidAt
                  && x.id !== m.id
                  && (x.projectId ?? '') === (m.projectId ?? '')
                  && (x.scope ?? 'global') === (m.scope ?? 'global'));
              },
              ask: async (prompt: string) => {
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
              },
            }
            : {};

          const { decision, write } = await admitMemory(gate, candidate);
          for (const item of write) await db.saveMemory(item).catch(() => undefined);

          const current = write.filter((m) => !m.invalidAt);
          if (current.length) {
            await memoryEndpoints()
              .then((ends) => indexMemories(ends, current))
              .catch(() => undefined);
          }

          console.log(`[ExecuteLeafActivity] ${leaf.id}: memory "${candidate.title}" -> ${decision.action}`);
          return decision;
        };

        const recalled = await recallMemories({
          memories: await db.getMemories(leaf.ownerId).catch(() => []),
          ownerId: leaf.ownerId,
          projectId: project?.id,
          query: recallQuery({
            title: leaf.title,
            ...(leaf.body ? { body: leaf.body } : {}),
            ...(leaf.expects?.length ? { expects: leaf.expects } : {}),
          }),
          endpoints: memoryEndpoints,
        });
        const memoryContext = recalled.context;

        if (recalled.selected.length) {
          console.log(`[ExecuteLeafActivity] ${leaf.id}: recalled ${recalled.selected.length} memories via ${recalled.via}`);
          void markUsed(db, recalled.selected);
        }

        let currentTaskContext = taskContext;
        let validationRound = 1;
        const maxValidationRounds = (leaf.validationContract || treeType?.validationRecipe || producesCode)
          ? DEFAULT_MAX_VALIDATION_ROUNDS
          : 1;
        let previousRoundRecord: ValidationRoundRecord | undefined;
        let loopSuccess = false;
        let finalValidationSummary: ValidationSummary | undefined;
        let loopHaltReason = '';

        let lastRunResult: any = { succeeded: false, tokensUsed: 0, completionTokensUsed: 0, trace: [] };
        let totalTokensUsed = 0;
        let totalCompletionTokensUsed = 0;
        const combinedTrace: any[] = [];

        while (validationRound <= maxValidationRounds) {
          beat({ phase: 'agent', round: validationRound });
          const singleRun = await runAgentLoop({
            // What the pack grants, not the whole catalogue. Passing everything is what showed a
            // leaf `list_mcp_servers` and then answered `Unknown tool` when it called it.
            catalogue: await new ToolService(db).schemas(leaf.ownerId, pack?.tools),
            runtime: {
              db,
              userId: leaf.ownerId,
              branchId: leaf.branchId,
              ...(repos ? { projects: repos } : {}),
              mcpRegistry: new McpRegistryService(db, leaf.ownerId, (name: string) => resolveMcpProbeUrl(name)),
            },
            images: await new WorkspaceImageService(db).list(leaf.ownerId),
            ...(pack?.sampling ? { sampling: pack.sampling } : {}),
            baseUrl,
            apiKey,
            model: provider.model,
            ...(provider.kind ? { kind: provider.kind } : {}),
            ...(pack?.workspace?.language ? { language: pack.workspace.language as WorkspaceLanguage } : {}),
            captureTrace: true,
            onStep: (step) => {
              beat({ phase: 'agent', step: step.step, tokensUsed: step.tokens, round: validationRound });
              void db.appendLeafStep({
                id: leaf.id,
                ownerId: leaf.ownerId,
                branchId: leaf.branchId,
                step: redactDeep(step, secretsInPlay()),
                totalSteps: step.step,
                tokensUsed: step.tokens,
                createdAt: new Date().toISOString(),
              }).catch((err) => {
                console.warn(`[ExecuteLeafActivity] leaf ${leaf.id}: could not record step ${step.step}: ${err?.message}`);
              });
            },
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
              ...(await resolveMcpForLeaf(db, pack, leaf)),
              ...(leaf.validationContract || treeType?.validationRecipe
                ? { validationRecipe: leaf.validationContract ?? treeType?.validationRecipe }
                : {}),
              saveMemory: async ({ category, title, text, suggestedScope }) => {
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
              },
              sandbox: {
                exec: (command) => workspaces.exec(leaf.id, command),
                readFile: (path) => workspaces.readFile(leaf.id, path),
                writeFile: (path, content) => workspaces.writeFile(leaf.id, path, content),
              },
              extendBudget: async (req) => {
                try {
                  beat({ phase: 'extend-probe', step: req.step, round: validationRound });

                  const current: ProgressSample = { at: { step: req.step, tokens: req.tokensUsed } };

                  if (checkout && branchName) {
                    const base = project?.defaultBranch || 'main';
                    const progress = await workspaces
                      .exec(leaf.id, buildProgressScript(), 60_000, [base])
                      .then((r) => parseProgress(r.stdout))
                      .catch(() => ({ commits: '', changed: '' }));
                    current.commits = progress.commits ? progress.commits.split('\n').filter(Boolean).length : 0;
                    const changed = /(\d+) insertions?\(\+\)/.exec(progress.changed);
                    current.changedLines = changed?.[1] ? Number(changed[1]) : 0;

                    if (leaf.expects?.length) {
                      const artifacts = await workspaces
                        .exec(leaf.id, buildArtifactCheckScript(leaf.expects, base, conventions), 60_000)
                        .then((r) => parseArtifactResult(r.stdout))
                        .catch(() => undefined);
                      if (artifacts) current.missingArtifacts = artifacts.missing.length;
                    }
                  } else if (outputPath) {
                    const text = await workspaces.readFile(leaf.id, outputPath).catch(() => '');
                    const verdict = assessFindings(text, outputPath, pack?.workspace?.requireSources !== false);
                    current.findingsChars = text.length;
                    current.findingsOutcome = verdict.outcome;
                  }

                  const evidence = compareProgress(lastProgress, current);
                lastProgress = current;

                let headroomTokens: number | undefined;
                const all = await db.getLeaves().catch(() => [] as Leaf[]);
                const root = rootLeaf(all, leaf);
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
                  `[ExecuteLeafActivity] leaf ${leaf.id}: budget ${req.exhausted} exhausted at step `
                  + `${req.step} — ${decision
                    ? decision.reason
                    : `no extension: ${refusalReason(extensionState) ?? 'refused'}`}`,
                );
                return decision;
              } catch (err: any) {
                console.warn(`[ExecuteLeafActivity] leaf ${leaf.id}: extension probe failed: ${err?.message}`);
                return undefined;
              }
            },
            checkpoint: async ({ number, handoff, tokensUsed: tokensUsedAtCheckpoint, maxTokens }) => {
              try {
                beat({ phase: 'checkpoint', number });

                const artifactPath = checkpointPath(leaf.id);
                const common = {
                  number,
                  taskTitle: leaf.title,
                  at: new Date().toISOString(),
                  tokensUsed: tokensUsedAtCheckpoint,
                  maxTokens,
                  handoff,
                };

                if (!checkout || !branchName) {
                  if (!outputPath) return undefined;
                  const text = await workspaces.readFile(leaf.id, outputPath).catch(() => '');
                  const verdict = assessFindings(text, outputPath, pack?.workspace?.requireSources !== false);

                  const artifact = buildCheckpointArtifact({
                    ...common,
                    findings: {
                      path: outputPath,
                      outcome: verdict.outcome,
                      reason: verdict.reason,
                      chars: text.length,
                    },
                  });

                  const fresh = await currentLeaf();
                  if (fresh && text.trim()) {
                    await db.saveLeaf({
                      ...fresh,
                      findings: text.slice(0, MAX_FINDINGS_CHARS),
                      updatedAt: new Date().toISOString(),
                    });
                  }
                  lastProgress = {
                    at: { step: 0, tokens: tokensUsedAtCheckpoint },
                    findingsChars: text.length,
                    findingsOutcome: verdict.outcome,
                  };

                  console.log(
                    `[ExecuteLeafActivity] leaf ${leaf.id}: checkpoint ${number} saved `
                    + `${text.length} chars of ${outputPath} (${verdict.outcome})`,
                  );
                  return { artifact };
                }

                const base = project?.defaultBranch || 'main';
                const progress = await workspaces
                  .exec(leaf.id, buildProgressScript(), 60_000, [base])
                  .then((r) => parseProgress(r.stdout))
                  .catch(() => ({ commits: '', changed: '' }));

                const artifact = buildCheckpointArtifact({
                  ...common,
                  repo: { branch: branchName, commits: progress.commits, changed: progress.changed },
                });

                lastProgress = {
                  at: { step: 0, tokens: tokensUsedAtCheckpoint },
                  commits: progress.commits ? progress.commits.split('\n').filter(Boolean).length : 0,
                  changedLines: Number(/(\d+) insertions?\(\+\)/.exec(progress.changed)?.[1] ?? 0),
                };

                await workspaces.writeFile(leaf.id, `/work/repo/${artifactPath}`, artifact);

                const saved = await workspaces
                  .exec(leaf.id, buildCheckpointScript(), 120_000, [branchName, artifactPath])
                  .then((r) => parseCheckpointResult(r.stdout))
                  .catch(() => undefined);

                if (saved) {
                  const fresh = await currentLeaf();
                  if (fresh) {
                    await db.saveLeaf({
                      ...fresh,
                      outputBranch: saved.branch,
                      updatedAt: new Date().toISOString(),
                    });
                  }
                }

                console.log(
                  `[ExecuteLeafActivity] leaf ${leaf.id}: checkpoint ${number} `
                  + `${saved ? `pushed ${saved.branch}@${saved.sha}` : 'written (not pushed)'}`,
                );

                return {
                  artifact,
                  ...(saved?.sha ? { sha: saved.sha } : {}),
                  ...(saved?.branch ? { branch: saved.branch } : {}),
                };
              } catch (err: any) {
                console.warn(`[ExecuteLeafActivity] leaf ${leaf.id}: checkpoint ${number} failed: ${err?.message}`);
                return undefined;
              }
            },
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
        const validator = new UniversalValidatorService();
        const valEnv = {
          exec: async (cmd: string) => {
            const cdCmd = checkout && branchName ? `cd /work/repo && ${cmd}` : cmd;
            const res = await workspaces.exec(leaf.id, cdCmd, 180_000);
            return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
          },
          readFile: async (p: string) => workspaces.readFile(leaf.id, `/work/repo/${p}`)
            .catch(() => workspaces.readFile(leaf.id, `/work/${p}`))
            .catch(() => workspaces.readFile(leaf.id, p)),
          fetch,
        };

        const isDocumentLeaf = Boolean(outputPath || !wantsRepo);
        let activeRecipe = leaf.validationContract
          ?? (isDocumentLeaf
            ? (treeType?.validationRecipe?.type === 'document' ? treeType.validationRecipe : undefined)
            : treeType?.validationRecipe);
        if (!isDocumentLeaf && (!activeRecipe || !activeRecipe.checks?.length)) {
          activeRecipe = await validator.inferRecipe(valEnv);
        }

        if (!activeRecipe || !activeRecipe.checks?.length) {
          loopSuccess = singleRun.succeeded;
          break;
        }

        finalValidationSummary = await validator.validate(activeRecipe, valEnv);
        if (finalValidationSummary.passed) {
          loopSuccess = true;
          console.log(`[WorkerValidatorLoop] leaf ${leaf.id}: Round ${validationRound} passed all ${finalValidationSummary.totalChecks} checks!`);
          break;
        }

        let repoDetails: { commits?: number; changedFiles?: string[] } | undefined;
        const statusOut = await workspaces.exec(leaf.id, 'git -C /work/repo status --porcelain 2>/dev/null', 30_000).catch(() => undefined);
        const logOut = await workspaces.exec(leaf.id, 'git -C /work/repo rev-list --count HEAD 2>/dev/null', 30_000).catch(() => undefined);
        const dirtyFiles = statusOut && statusOut.exitCode === 0 ? statusOut.stdout.split('\n').filter(Boolean).map((l) => l.trim().slice(2).trim()) : [];
        const commits = logOut && logOut.exitCode === 0 ? Number(logOut.stdout.trim()) || 0 : undefined;
        const changedFiles = dirtyFiles.length ? dirtyFiles : undefined;
        if (commits !== undefined || changedFiles !== undefined) {
          repoDetails = {
            ...(commits !== undefined ? { commits } : {}),
            ...(changedFiles !== undefined ? { changedFiles } : {}),
          };
        }

        const currentRoundRecord = recordFromSummary(validationRound, finalValidationSummary, repoDetails);
        await writeValidationArtifacts(workspaces, leaf.id, finalValidationSummary, currentRoundRecord);

        const assessment = assessLoopProgress(previousRoundRecord, currentRoundRecord, maxValidationRounds, singleRun.stoppedBecause);

        if (assessment.shouldContinue && assessment.feedbackPrompt) {
          console.log(`[WorkerValidatorLoop] leaf ${leaf.id}: Round ${validationRound} failed (${finalValidationSummary.failedChecks} failures), handing back to worker: ${assessment.reason}`);
          previousRoundRecord = currentRoundRecord;
          currentTaskContext = [
            taskContext,
            '',
            `The project Validator tested your work. Detailed test results and logs have been recorded in \`${VALIDATION_FEEDBACK_FILE}\` in your workspace.`,
            `Fix the failing checks and verify they pass before calling finish:`,
            '',
            assessment.feedbackPrompt,
          ].join('\n');
          validationRound++;
        } else {
          loopSuccess = false;
          loopHaltReason = assessment.reason;
          console.warn(`[WorkerValidatorLoop] leaf ${leaf.id}: Loop halted at round ${validationRound}: ${assessment.reason}`);
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

        const pushBack = async (): Promise<string | undefined> => {
          if (!checkout || !branchName) return undefined;
          beat({ phase: 'push' });
          const pushed = await workspaces
            .exec(leaf.id, buildPushScript(branchName), 120_000, [branchName])
            .catch(() => undefined);
          const confirmed = pushed ? parsePushedBranch(pushed.stdout) : undefined;
          if (!confirmed) {
            console.warn(`[ExecuteLeafActivity] leaf ${leaf.id} pushed nothing to ${branchName}`);
          }
          return confirmed;
        };

        let findings = '';
        if (outputPath) {
          findings = await workspaces.readFile(leaf.id, outputPath).catch(() => '');
        }

        let verify: VerifyResult = { outcome: 'unverified', output: '' };
        const isDocumentLeaf = Boolean(outputPath || !wantsRepo);
        const activeRecipe = leaf.validationContract
          ?? (isDocumentLeaf
            ? (treeType?.validationRecipe?.type === 'document' ? treeType.validationRecipe : undefined)
            : treeType?.validationRecipe);
        const declaredVerify = Boolean((producesCode && leaf.verifyCommand?.trim()) || activeRecipe || finalValidationSummary);
        const verifyCommand = producesCode ? (leaf.verifyCommand?.trim() || defaultVerifyCommand(workLanguage)) : '';

        if (outputPath) {
          const verdict = assessFindings(findings, outputPath, pack?.workspace?.requireSources !== false);
          verify = { outcome: verdict.outcome, output: verdict.reason };
        } else if (finalValidationSummary) {
          verify = {
            outcome: finalValidationSummary.passed ? 'passed' : 'failed',
            output: finalValidationSummary.diagnosticReport,
          };
        } else if (activeRecipe && activeRecipe.checks?.length) {
          beat({ phase: 'verify' });
          const validator = new UniversalValidatorService();
          const summary = await validator.validate(activeRecipe, {
            exec: async (cmd) => {
              const cdCmd = checkout && branchName ? `cd /work/repo && ${cmd}` : cmd;
              const res = await workspaces.exec(leaf.id, cdCmd, 180_000);
              return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
            },
            readFile: async (p) => {
              return workspaces.readFile(leaf.id, `/work/repo/${p}`).catch(() =>
                workspaces.readFile(leaf.id, `/work/${p}`).catch(() =>
                  workspaces.readFile(leaf.id, p)
                )
              );
            },
          }).catch(() => undefined);

          if (summary) {
            verify = {
              outcome: summary.passed ? 'passed' : 'failed',
              output: summary.diagnosticReport,
            };
          }
        } else if (verifyCommand) {
          beat({ phase: 'verify' });
          verify = await workspaces
            .exec(leaf.id, buildVerifyScript(verifyCommand, workLanguage), 300_000)
            .then((r) => parseVerifyResult(r.stdout))
            .catch(() => ({ outcome: 'unverified' as const, output: '' }));
        }

        const pushedBranch = await pushBack();
        if (wantsRepo && leaf.expects?.length) beat({ phase: 'artifacts' });
        const artifacts = wantsRepo && leaf.expects?.length
          ? await workspaces
              .exec(leaf.id, buildArtifactCheckScript(leaf.expects, project?.defaultBranch || 'main', conventions), 60_000)
              .then((r) => parseArtifactResult(r.stdout))
              .catch(() => ({ outcome: 'unknown' as const, missing: [], moved: [] }))
          : { outcome: 'none' as const, missing: [], moved: [] };

        if (artifacts.moved.length) {
          console.log(`[ExecuteLeafActivity] leaf ${leaf.id}: declared artifacts found elsewhere — ${artifacts.moved.join(', ')}`);
        }
        if (artifacts.outcome === 'stale') {
          console.log(`[ExecuteLeafActivity] leaf ${leaf.id}: declared artifacts already present and unchanged — ${artifacts.missing.join(', ')}`);
        }

        let dockerProblems = '';
        if (producesCode) {
          const dockerfile = await workspaces.readFile(leaf.id, '/work/repo/Dockerfile').catch(() => '');
          if (dockerfile.trim()) {
            const listing = await workspaces
              .exec(leaf.id, 'cd /work/repo && git ls-files')
              .then((r) => String(r.stdout ?? '').split('\n').map((f) => f.trim()).filter(Boolean))
              .catch(() => [] as string[]);
            const ignore = await workspaces.readFile(leaf.id, '/work/repo/.dockerignore').catch(() => '');
            let hasDependencies: boolean | undefined;
            const manifest = await workspaces.readFile(leaf.id, '/work/repo/package.json').catch(() => '');
            if (manifest.trim()) {
              try {
                const parsed = JSON.parse(manifest) as { dependencies?: object; devDependencies?: object };
                hasDependencies = Object.keys(parsed.dependencies ?? {}).length > 0
                  || Object.keys(parsed.devDependencies ?? {}).length > 0;
              } catch { /* unparseable manifest: stay undefined rather than guess */ }
            }
            dockerProblems = describeDockerfileProblems(
              checkDockerfile(dockerfile, listing, ignore || undefined, hasDependencies),
            );
            if (dockerProblems) {
              console.warn(`[ExecuteLeafActivity] leaf ${leaf.id}: ${dockerProblems.replace(/\n/g, ' ')}`);
            }
          }
        }

        const earned = outputPath
          ? verify.outcome
          : evidenceOf(verify.outcome, { declaredCommand: declaredVerify, changed: Boolean(pushedBranch) });
        if (earned !== verify.outcome) {
          console.warn(
            `[ExecuteLeafActivity] leaf ${leaf.id}: default suite passed but nothing was committed — recording unverified, not verified`,
          );
        }

        const combined = combineVerification(earned, artifacts.outcome);
        const settled = dockerProblems ? 'failed' : decideStatus(run.succeeded, combined);

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
            ...(checkout && branchName ? { base: project?.defaultBranch || 'main' } : {}),
            ...(leaf.expects?.length ? { expects: leaf.expects } : {}),
            ...(verify.output ? { verifyOutput: verify.output } : {}),
            ...(findings.trim() ? { findings: findings.slice(0, MAX_FINDINGS_CHARS) } : {}),
          });
          await db.saveLeafEvidence(leaf.id, redactDeep(evidence, secretsInPlay()));
        } catch (err: any) {
          console.warn(`[ExecuteLeafActivity] leaf ${leaf.id}: could not capture evidence: ${err?.message}`);
        }

        try {
          const tracked = await workspaces
            .exec(
              leaf.id,
              "cd /work/repo 2>/dev/null && git ls-files "
              + "| grep -vE '^(node_modules|vendor|\\.venv|venv|dist|build|__pycache__|\\.koala)/' | head -60",
              60_000,
            )
            .then((r) => r.stdout.split('\n').map((l) => l.trim()).filter(Boolean))
            .catch(() => [] as string[]);

          const learned = extractLeafMemories({
            leaf: { ...leaf, ...(project ? { projectId: project.id } : {}) },
            trackedFiles: tracked,
            summary: run.summary,
            succeeded: settled === 'succeeded',
            missingArtifacts: artifacts.missing,
            ...(verify.output ? { verifyOutput: verify.output } : {}),
          });

          if (learned.length) {
            const { save, invalidate } = supersede(await db.getMemories(leaf.ownerId), learned);
            for (const item of invalidate) await db.saveMemory(item).catch(() => undefined);

            for (const item of save) await admit(item);
          }
        } catch (err) {
          console.warn(`[ExecuteLeafActivity] could not record what leaf ${leaf.id} learned: ${(err as Error).message}`);
        }

        if (settled === 'failed') {
          const partial = pushedBranch;
          if (checkout) beat({ phase: 'repo-state' });
          const state = checkout
            ? await workspaces.exec(leaf.id, buildRepoStateScript(), 60_000)
                .then((r) => summariseRepoState(r.stdout))
                .catch(() => '')
            : '';
          const freshOnFailure = await currentLeaf();
          if (freshOnFailure) await db.saveLeaf({
            ...freshOnFailure,
            usage: spent,
            ...(partial ? { outputBranch: partial } : {}),
            ...(project ? { projectId: project.id } : {}),
            ...(findings.trim() ? { findings: findings.slice(0, MAX_FINDINGS_CHARS) } : {}),
            updatedAt: new Date().toISOString(),
          });
          throw new Error([
            verify.outcome === 'failed' && run.succeeded
              ? `The agent reported success, but the checks failed. Its report: ${run.summary}`
              : run.summary,
            ...(verify.outcome === 'failed' ? [`Verification failed (\`${verifyCommand}\`):\n${verify.output}`] : []),
            ...(artifacts.outcome === 'missing'
              ? [`These files were required and are not committed: ${artifacts.missing.join(', ')}. Create them and commit before finishing.`]
              : []),
            ...(dockerProblems ? [dockerProblems] : []),
            ...(partial ? [`Work so far is committed on ${partial} and will be waiting at /work/repo next attempt.`] : []),
            ...(state ? [`State of the repository when this attempt ended:\n${state}`] : []),
          ].join('\n\n'));
        }

        const outputBranch = pushedBranch;

        let merged = false;
        if (outputBranch && combined === 'passed' && !dockerProblems) {
          beat({ phase: 'merge' });
          const result = await workspaces
            .exec(leaf.id, buildMergeScript(outputBranch), 120_000, [outputBranch])
            .then((r) => parseMergeResult(r.stdout))
            .catch(() => 'skipped' as const);
          merged = result === 'merged';
          if (!merged) {
            console.warn(`[ExecuteLeafActivity] leaf ${leaf.id} verified but not merged (${result}); work remains on ${outputBranch}`);
          }
        }

        const now = new Date().toISOString();
        const freshOnSuccess = await currentLeaf();
        if (freshOnSuccess) await db.saveLeaf({
          ...freshOnSuccess, usage: spent, status: 'succeeded', column: 'review', checks,
          ...(run.summary ? { summary: redactSecrets(run.summary.slice(0, 8000), secretsInPlay()) } : {}),
          verified: combined === 'passed',
          merged,
          ...(project ? { projectId: project.id } : {}),
          ...(outputBranch ? { outputBranch } : {}),
          ...(findings.trim() ? { findings: findings.slice(0, MAX_FINDINGS_CHARS) } : {}),
          updatedAt: now,
        });
        return { leafId: leaf.id, tokensUsed: run.tokensUsed, summary: run.summary };
      } finally {
        await workspaces.destroy(leaf.id).catch(() => undefined);
        if (repos && checkout) await repos.revokeCheckout(leaf.ownerId, checkout.tokenName).catch(() => undefined);
      }
    } catch (err: any) {
      const after = await currentLeaf().catch(() => undefined);
      const produced = Boolean(after?.outputBranch || after?.findings?.trim());

      const attempts: LeafAttempt[] = [
        ...priorFailures,
        {
          attempt: Math.max(0, attemptNumber - 1),
          error: redactSecrets(String(err?.message ?? err).slice(0, 2000), secretsInPlay()),
          failedAt: new Date().toISOString(),
          produced,
        },
      ];
      const nextStatus = statusAfterFailure(attemptNumber, MAX_LEAF_ATTEMPTS);
      const latest = await currentLeaf();
      if (latest) {
        await db.saveLeaf({
          ...latest,
          attempts,
          status: nextStatus,
          ...(diagnosis ? { summary: redactSecrets(diagnosis.slice(0, 8000), secretsInPlay()) } : {}),
          updatedAt: new Date().toISOString(),
        });
      }

      try {
        const branch = (await db.getBranches()).find((b: Branch) => b.id === latest?.branchId);
        if (branch && latest) {
          await db.saveBranch(withNotice(branch, buildFailureNotice(
            latest.title,
            String((err as Error)?.message ?? err),
            attempts.length,
            MAX_LEAF_ATTEMPTS,
          )));
        }
      } catch (noticeErr) {
        console.warn(`[ExecuteLeafActivity] could not report the failure of ${args.leafId}: ${(noticeErr as Error).message}`);
      }

      if (selfDiagnosed) {
        console.warn(`[ExecuteLeafActivity] leaf ${args.leafId}: stopped itself (${selfDiagnosed}) — not retrying`);
        throw ApplicationFailure.nonRetryable(
          `${String((err as Error)?.message ?? err)}\n\n`
          + `The run diagnosed itself as ${selfDiagnosed === 'circling' ? 'going in circles' : selfDiagnosed === 'thrashing' ? 'producing nothing' : 'having stopped calling tools'}. `
          + 'Another identical attempt reproduces it rather than fixing it — this needs the task, the '
          + 'tools or the environment changed, which is what POST /api/leaves/:id/review is for.',
          'SelfDiagnosedStop',
        );
      }

      if (barrenStreak(priorFailures, produced)) {
        console.warn(
          `[ExecuteLeafActivity] leaf ${args.leafId}: two attempts produced nothing — not retrying`,
        );
        throw ApplicationFailure.nonRetryable(
          `${String((err as Error)?.message ?? err)}\n\n`
          + 'Stopped after two attempts that produced no commits and no written output. '
          + 'This is usually something the agent cannot see rather than something more time fixes — '
          + 'check the task, the persona\'s tools, and whether the repository has what it needs.',
          'NoProgress',
        );
      }

      throw err;
    }
  } finally {
    await db.close();
  }
}
