/**
 * ExecuteLeafActivity — where a leaf's actual work happens.
 *
 * ── THE ARGUMENT IS JUST AN ID ──
 * This takes a leafId and nothing else. Everything it needs — the leaf, its body, its failure
 * history, and eventually retrieved memory — is read from MongoDB at execution time.
 *
 * That is what makes Temporal's own retry policy usable. The objection to native retries is that
 * they replay identical input, so an agent task fails identically every attempt. That is only true
 * when the context IS the input. Here the input is `{ leafId }` on every attempt while the context
 * is assembled fresh, and the previous attempt's failure was written to Mongo before it threw — so
 * attempt N+1 reads a database that attempt N changed. Same args, different prompt.
 *
 * It also keeps workflow history small. Temporal caps payload sizes, and threading a full prompt
 * (plus accumulated failures, plus retrieved documents) through workflow arguments would put all of
 * it in history, replayed on every activation.
 *
 * ── FAILURES ARE RECORDED BEFORE THROWING ──
 * Not after, and not by the caller. If the record were written by whoever catches the error, a
 * worker crash between the failure and the catch would lose the reason — and the retry would repeat
 * the same mistake with no idea it had made it before.
 */
import { Context } from '@temporalio/activity';
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
import { resolveConfig } from '../lib/personas.js';
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

export interface ExecuteLeafArgs {
  leafId: string;
}

/**
 * The conventional place for an answer, for a persona that names no file of its own.
 *
 * Outside /work/repo on purpose: a persona producing an answer has no checkout, and a path under
 * one would imply a repository that was never cloned.
 *
 * Not used as a fallback by the activity — a persona with no `output` is not checked against a file
 * it never promised. This is what the seeds are written against.
 */
export const FINDINGS_PATH = '/work/findings.md';

/** Bounded like `summary` is: this goes into a Mongo document that also holds every attempt. */
export const MAX_FINDINGS_CHARS = 20000;

/**
 * Reports progress to Temporal, from anywhere, safely.
 *
 * Two callers with two different reasons. During the loop it beats per agent step. AFTER the loop
 * it beats at each phase boundary — push, verify, artifacts, repo-state, merge — because those are
 * single sandbox execs with nothing inside them to report, and a leaf that finished its work and
 * went quiet while proving it is exactly the leaf that must not be killed.
 *
 * The boundaries are chosen so the longest gap between two beats is ONE exec, not a run of them:
 * verify alone is 300 seconds, and verify-then-artifacts-then-repo-state unbeaten would have been
 * most of the heartbeat window on its own. That is the number `executeLeafActivityMeta` is sized
 * against — change one and read the other.
 *
 * Swallows everything: `Context.current` THROWS outside an activity, and this loop is also driven
 * by the Lab and by tests. A failure to report progress is never a reason to stop making it.
 */
function beat(note: Record<string, unknown>): void {
  try {
    Context.current().heartbeat(note);
  } catch {
    // Not running as an activity. Nothing is listening, and nothing needs to be.
  }
}

export interface ExecuteLeafResult {
  leafId: string;
  /**
   * Tokens consumed by this attempt, REPORTED not delegated.
   *
   * This activity persists usage itself, on both exit paths — see `spent` below. The caller must
   * not add it to the leaf again: doing so double-counted every succeeded leaf, because a failed
   * attempt throws and never returns a result to add.
   */
  tokensUsed: number;
  summary: string;
}

/**
 * Assembles everything a persona needs to act on a leaf.
 *
 * Exported so the prompt-building can be tested without running an activity, and so Phase C adds
 * retrieval sources here rather than changing the workflow contract.
 */
export function buildLeafContext(leaf: Leaf, priorFailures: LeafAttempt[]): string {
  const parts = [`Task: ${leaf.title}`];
  if (leaf.body) parts.push(leaf.body);

  // The whole point of retrying. Without this the next attempt is identical to the one that just
  // failed, which is exactly what Temporal's built-in retry would give for free.
  const failures = failureContext(priorFailures);
  if (failures) parts.push(failures);

  return parts.join('\n\n');
}

/**
 * The MCP tools a leaf may use, and the handler that runs them.
 *
 * Returns nothing for a persona that asked for nothing, so the common case costs no work and no
 * tokens. Every failure is soft: a registry that cannot be reached must not stop a leaf that was
 * never going to use it.
 */
async function resolveMcpForLeaf(db: any, persona: any, leaf: any): Promise<Record<string, unknown>> {
  /**
   * The persona's grants AND the leaf's own. A persona is written before anything is deployed, so
   * on its own it can never name a server this plan is about to build — measured on the live
   * instance, every persona had an empty list, which made the whole build-then-use loop impossible.
   */
  const wanted = [...new Set([...wantsMcp(persona), ...(leaf?.mcp ?? [])])];
  if (!wanted.length) return {};

  try {
    // Scoped to the leaf's owner: a registry that reads every deployment would offer one
    // tenant's agent the tools of another tenant's service.
    const registry = new McpRegistryService(db, leaf.ownerId, (name: string) => resolveMcpProbeUrl(name));
    const { servers, missing } = resolveForPersona(wanted, await registry.listWithTools());

    if (missing.length) {
      // Said out loud rather than silently handing back a smaller toolset: a named server that is
      // not running is a configuration mistake, and the run would otherwise fail later for a reason
      // nothing on screen explains.
      console.warn(`[ExecuteLeafActivity] leaf ${leaf.id}: persona named MCP servers that are not running — ${missing.join(', ')}`);
    }
    for (const gap of mcpGaps(servers, persona?.scope?.egress, (s: any) => s.deploymentName ?? s.name)) {
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
    // A leaf that meant to use a service and now cannot is better off running without it than not
    // running at all — that shows up in its own summary rather than as a crash here.
    console.warn(`[ExecuteLeafActivity] leaf ${leaf.id}: could not resolve MCP servers — ${String(err?.message ?? err).slice(0, 200)}`);
    return {};
  }
}

export async function ExecuteLeafActivity(args: ExecuteLeafArgs): Promise<ExecuteLeafResult> {
  /**
   * Falls back to 1 outside an activity context, so the function stays callable from a test.
   *
   * Caught rather than guarded with `?.`: `Context.current` is always defined and THROWS when there
   * is no activity around it, so the optional call this used to be protected nothing and made the
   * function unreachable from anywhere but a worker.
   */
  let attemptNumber = 1;

  /**
   * The credentials in play this run, for redaction at every storage boundary.
   *
   * A trace holds every command's stdout and `LeafEvidence` holds diffs and file contents; both go
   * to Mongo verbatim. The checkout credential is the likeliest to appear — it lives in a file
   * under /work and the agent may read any file it likes — and while it is revoked at teardown, the
   * model's API key is not, and neither is anything the agent found in the repository.
   *
   * Declared at FUNCTION scope, not beside the checkout that fills it: the catch below records the
   * failure text, which is read by the next attempt, and it cannot see anything scoped to the try.
   * Filled in once, when the values exist.
   */
  let runSecrets: (string | undefined)[] = [];
  const secretsInPlay = () => runSecrets;
  try {
    attemptNumber = Context.current().info.attempt;
  } catch {
    // Not in a worker. One attempt, by definition.
  }

  const db = createDatabase();
  await db.init();
  try {
    // The whole list, not just this leaf: `baseBranchesFor` needs the dependencies' output
    // branches to know where this leaf should start from.
    const allLeaves = await db.getLeaves();
    const leaf = allLeaves.find((c: Leaf) => c.id === args.leafId);
    // A leaf deleted mid-flight is a normal race, not an error — failing would only produce a
    // retry storm against a row that is never coming back.
    if (!leaf) return { leafId: args.leafId, tokensUsed: 0, summary: 'Leaf no longer exists' };

    const priorFailures = leaf.attempts ?? [];

    /**
     * What the run concluded about itself, hoisted so the catch below can see it.
     *
     * The loop's verdict is computed deep inside the try and the decision that needs it — whether
     * another attempt is worth making — is taken in the catch. Declaring them here is what connects
     * the two without re-deriving anything from the error text.
     */
    let diagnosis: string | undefined;
    let selfDiagnosed: 'circling' | 'thrashing' | 'silent' | undefined;
    const context = buildLeafContext(leaf, priorFailures);

    /**
     * This leaf AS IT IS NOW, read immediately before every write. Undefined means it is gone.
     *
     * ── WHY IT IS READ AT ALL ──
     * Deleting a branch cancels its leaves' workflows and removes the rows, but an activity already
     * inside the agent loop does not stop — and `saveLeaf` is an upsert, so its final write
     * RECREATES the leaf pointing at a branch that is gone. Observed live: an orphan reappeared in
     * the tree under a derived node, and deleting the branch again could not remove it because the
     * branch was already deleted.
     *
     * A read before each write rather than one check up front: the whole race is that the delete
     * lands DURING the run, so a check at the start would answer the wrong question.
     *
     * ── WHY IT RETURNS THE RECORD RATHER THAN A BOOLEAN ──
     * It used to answer only "does it exist", and every caller then spread the `leaf` object read
     * at the top of the activity — minutes earlier, sometimes an hour. `saveLeaf` is a full
     * replace, so a title or body edited while the agent worked was silently reverted by the write
     * that recorded the result. Existence and freshness come from the same read; handing back a
     * boolean threw the useful half away. The catch path below already did this by hand.
     */
    const currentLeaf = async (): Promise<Leaf | undefined> =>
      (await db.getLeaves()).find((l: Leaf) => l.id === leaf.id);

    try {
      // Resolved HERE rather than passed in: an API key is a secret, and a workflow argument ends
      // up in Temporal history. See lib/model-wiring.ts.
      const models = createModelService(db, process.env.JWT_SECRET ?? '');

      /**
       * The adopted model, if one was promoted — read here rather than only below.
       *
       * Promotion is supposed to mean a setting that won on the bench takes effect on the work that
       * matters. For every other knob that happens through `overrides` further down, but `model`
       * selects a PROVIDER and so has to be resolved, not passed. Without this the adopted value
       * was carried into the loop and ignored, and leaves silently kept running whichever provider
       * happened to be listed first.
       */
      /**
       * The leaf's persona, if it was assigned one.
       *
       * `Leaf.personaId` has existed since the board did and was read by nothing — LeafWorkflow
       * still says "Phase B has no personas". This is where it starts meaning something: the same
       * precedence the chat route uses, so a persona behaves identically whether you talk to it or
       * hand it work.
       *
       * A dangling id resolves to null and the leaf runs with no persona rather than failing —
       * deleting a persona must not break the leaves that already ran under it.
       */
      const profile = await db.getHarnessProfile(leaf.ownerId);
      /**
       * The leaf's own persona, or the one promoted from the Lab.
       *
       * The fallback is what makes a promotion mean anything. Without it, a persona that won on the
       * bench was written to the profile and read by nothing — the Lab could discover a better
       * prompt and no leaf would ever run it unless someone assigned it by hand, every time.
       *
       * Leaf first, deliberately: an adopted default is a default, and work that named a persona
       * has already made a more specific choice.
       */
      /**
       * Whoever the planner chose, or whoever won in the Lab. Nothing else.
       *
       * There is deliberately no category-based fallback: a persona picked because the work was
       * filed as "research" is a persona nobody chose, configured by a label rather than by a
       * decision. A leaf that reaches here with neither is a planning failure and says so.
       */
      const ownPersonas = (await db.getPersonas()).filter((p) => p.ownerId === leaf.ownerId);
      const wanted = leaf.personaId ?? profile?.personaId;
      const assigned = wanted ? ownPersonas.find((p) => p.id === wanted) : undefined;
      // Flattened, so a persona defined as "that one, but ..." runs with everything it inherits.
      const persona = assigned ? flattenPersona(assigned, ownPersonas) : null;
      const wantsRepo = usesRepo(persona);

      /**
       * ── WHAT THIS TREE IS PRODUCING, FROM ITS TYPE RECORD ──
       *
       * Resolved here rather than inside the checkout block, because the type decides the workspace
       * as well as the starter files, and the workspace is built first.
       *
       * `TreeTypeSpec` has declared `language` and `produces` since trees were introduced and
       * nothing read either — so the same two decisions were made on the persona, in `templateFor`'s
       * switch, and in a `producesCode` check derived from `scope.output`. Three copies of one fact,
       * which is how a research tree ended up with an image that could not clone.
       */
      const branchOfLeaf = (await db.getBranches()).find((b) => b.id === leaf.branchId);
      const treeOf = branchOfLeaf?.treeId
        ? (await db.getTrees()).find((t) => t.id === branchOfLeaf.treeId)
        : undefined;
      const treeType = await resolveTreeType(db, leaf.ownerId, treeOf?.type);
      /**
       * What this project type says its files look like, derived from its scaffold.
       *
       * Used by the artifact check so a planner's guessed extension does not fail correct work, and
       * composed into the planning turn so the guess is right in the first place. See
       * lib/tree-type-conventions.ts for the leaf this cost.
       */
      const conventions = conventionsOf(treeType);

      /**
       * Whether the work is CODE — a test run and a Dockerfile check — or a document that is read.
       *
       * The TYPE answers this, not the persona: the same Builder writes a service on one tree and a
       * report on another. Absent when a leaf has no tree (a bare leaf created by hand), in which
       * case the old signal stands — a persona that names an output produces a document.
       */
      const producesCode = Boolean(
        (treeType && (treeType.produces === 'service' || treeType.validationRecipe || (treeType.files?.length ?? 0) > 0)) ||
        (!treeType && !persona?.scope?.output) ||
        leaf.validationContract ||
        leaf.projectId ||
        (treeOf?.projectIds?.length ?? 0) > 0 ||
        usesRepo(persona)
      );

      /**
       * The language this work is in, resolved ONCE.
       *
       * Used by the workspace image and by the verify command, which have to agree: the first
       * version resolved the image from the type and left the verify command reading
       * `persona.scope.language`, so a Python tree got `python-312` and then `node --test`. A green
       * `unittest` suite would have scored `unverified`, and an unverified leaf falls back to the
       * agent's own claim about its work.
       *
       * Persona first because it is an explicit override — a Node persona working in a Python
       * repository is a real thing. Absent means "whatever this tree produces".
       */
      const workLanguage = (persona?.scope?.language ?? treeType?.language) as WorkspaceLanguage | undefined;
      /**
       * Where this persona says its deliverable goes. Absent means it produces files, not an answer.
       *
       * ── REWRITTEN UNDER THE CHECKOUT, ONCE ──
       * A persona says WHAT its deliverable is (`/work/findings.md`); the harness decides where the
       * workspace root is, exactly as it does for a coding leaf that never names `/work/repo`. So a
       * document leaf with a checkout writes into the repository and its answer is committed rather
       * than surviving only as a capped database field.
       *
       * Done here rather than on the persona records so no migration is needed and
       * `ensurePersonas` — which only ever ADDS — cannot leave existing personas on the old path.
       * Every later use of `outputPath` reads this one value.
       */
      const declaredOutput = persona?.scope?.output;
      const outputPath = declaredOutput;

      const resolved = resolveConfig(profile, persona);
      /**
       * The prompt goes back into the bag here, unlike in chat.
       *
       * Two transports for one value: the chat route composes it into a system MESSAGE, while the
       * agent loop reads `overrides.systemPrompt` as a loop-placement knob. `resolveConfig` keeps
       * them apart so neither caller has to know about the other's mechanism, which means this
       * caller has to say which one it is.
       */
      const adopted = resolved.systemPrompt
        ? { ...resolved.overrides, systemPrompt: resolved.systemPrompt }
        : resolved.overrides;
      const chosen = typeof adopted.model === 'string' ? adopted.model : undefined;
      const { provider, baseUrl, apiKey } = await models.resolveBaseUrl(leaf.ownerId, chosen);
      // The API key exists from here; the checkout is added below once it is minted.
      runSecrets = [apiKey];

      /**
       * A leaf attached to a project gets that repository cloned in, and pushes a branch back.
       *
       * The credential is minted per attempt and revoked on teardown, and egress is opened to the
       * Gitea namespace ONLY — so the token the sandbox holds has both a narrow scope (push to
       * this user's repos, nothing else) and nowhere to be exfiltrated to.
       */
      let branchName: string | undefined;
      let repos: ProjectRepoService | undefined;
      let checkout: { cloneUrl: string; tokenName: string; username: string } | undefined;
      let gitea0 = '';
      /** Sandboxes this attempt stood up, folded into `spent` so it lands on both exit paths. */
      let workspacesCreated = 0;
      /**
       * The last progress reading, so an extension is decided on a DELTA rather than an absolute.
       *
       * "There are four commits" says nothing; "there are two more commits than at the last ceiling"
       * is the whole signal. Scoped to the attempt, because a new attempt starts from a fresh clone.
       */
      let lastProgress: ProgressSample | undefined;
      /**
       * Every leaf gets a repository now, not only one that was given a project.
       *
       * Opt-in persistence meant the DEFAULT path threw the work away: the sandbox is a pod, and
       * when it is destroyed an uncommitted file goes with it while the leaf still reports success.
       * Failing to provision is not fatal — the leaf runs without a repository, exactly as before,
       * which is worse than persisting but better than not running.
       */
      // Held rather than constructed inline: wiring the project for builds needs the node's
      // address, which is the same kubectl this already owns.
      const infra = new InfrastructureService();
      const gitea = new GiteaService(
        infra,
        process.env.JWT_SECRET ?? '',
        process.env.MANAGEMENT_KUBECONFIG ?? '/tmp/kubeconfig-provisioning-lunorica',
      );
      /**
       * ── EVERY LEAF THAT WRITES FILES WORKS IN THE TREE'S REPOSITORY ──
       *
       * This used to read `if (!wantsRepo)`, so a research leaf got no repository at all and its
       * deliverable lived only as a capped field on the leaf record. Measured: a finished playbook
       * was persisted at exactly `MAX_FINDINGS_CHARS` — cut mid-URL — and the rest went with the pod.
       * Its dependencies' answers had to be copied into its prompt, its previous attempt was pasted
       * back on retry, and its checkpoint had nowhere to write.
       *
       * The reasoning that put it there was sound and is preserved: provisioning a repo for a
       * persona whose work is not code ALSO broke its verification, because `defaultVerifyCommand`
       * looks for a test suite it will never have. That is now a separate question — see
       * `writesFiles` versus `usesRepo` in lib/persona-scope.ts. A document persona gets a checkout
       * and is still judged by `assessFindings`, never by a test run.
       *
       * `usesRepo`'s own warning — "27 projects of which 26 never built: one per request" — is
       * answered by two things: the repository is resolved per TREE, so an effort has one rather
       * than one per request; and a document leaf commits its deliverable into it, so it is not an
       * empty repo created on the assumption that all work has somewhere to commit.
       */
      let project: ProjectMetadata | undefined;
      if (!wantsRepo) {
        console.log(`[ExecuteLeafActivity] leaf ${leaf.id}: persona writes no files, so no checkout`);
      } else try {
        const projectRepos = new ProjectRepoService(db, gitea, process.env.JWT_SECRET ?? '');
        /**
         * The tree's repository, when this leaf's conversation belongs to one.
         *
         * Looked up here rather than inside resolveLeafProject so that module still knows nothing
         * about trees or branches. Without it every branch of one effort gets its own repository,
         * and continuing an effort in a new conversation starts again from an empty repo.
         */
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
        // Added the moment it is minted, so nothing written after this point can carry it.
        runSecrets = [...runSecrets, checkout.cloneUrl, checkout.tokenName];

        /**
         * Seed the repository with the shape its tree implies, before the agent touches it.
         *
         * Every project started empty, so the first leaf spent its budget rediscovering the same
         * things and getting them wrong the same ways — no Dockerfile so nothing could build,
         * nothing reading PORT so the container exited, a hunt for a test runner. All identical
         * every time, which is what makes it a template rather than work.
         *
         * Skips anything already there, so this is a no-op on the second leaf and on any repository
         * that already has content. Failures are logged, never thrown: an unseeded repository is
         * one the agent has to fill in itself, which is exactly where it was before.
         */
        try {
          /**
           * The skeleton comes from the TYPE RECORD, not from a switch on its name.
           *
           * `templateFor(treeType)` keyed a `switch` on type strings — one of three places that
           * duplicated what the type already declared. Now a type carries its own starter files and
           * the placeholders are filled here, so adding a project type with its own skeleton is a
           * form rather than a deploy.
           */
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

        /**
         * Wire the repository so a push can actually become a deployment.
         *
         * Every project Koala creates went through resolveLeafProject, which registered no webhook
         * and set no target cluster — so the repositories the agent fills with code were exactly
         * the ones that could never ship. Measured: four agent-created projects on this instance,
         * none of them buildable.
         *
         * Problems are logged, never thrown: a leaf that produced working code must not fail
         * because a webhook could not be registered.
         */
        // Only for work that is CODE. A research repository holds documents; wiring it for builds
        // registers a webhook that will never fire and asks the cluster for an address nobody needs.
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

        // The tree learns what its work produced. Re-read before writing: saveTree is a full
        // replace and sibling leaves resolve their project concurrently.
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
      // Deterministic from the leaf id, so a retry after a worker crash reuses the namespace
      // rather than leaking the last attempt's.
      await workspaces.destroy(leaf.id).catch(() => undefined);
      /**
       * ── THE CONTAINER: ROLE FROM THE PERSONA, WORK FROM THE TREE ──
       *
       * The persona owns what the ROLE always gets — its budgets, its tools, the services it may
       * always reach. The tree type owns what THIS WORK is: the language it is written in, and
       * whether there is a checkout. Neither knows the other's half, and the previous two versions
       * of this comment each claimed one side owned both.
       */
      /**
       * ── WHAT THE PROJECT DECLARED IT NEEDS, MADE REACHABLE ──
       *
       * `project.needs` is the same list a deploy binds from (DeployAppActivity), resolved through
       * the same ownership-checked function. Until now it was honoured only at deploy time, so a
       * leaf could write code against `$SERVICE_BINDING_ROOT` and never run it.
       *
       * What that cost, measured on two projects: a leaf looked for `$SERVICE_BINDING_ROOT` at step
       * 2, found nothing, searched the whole filesystem, spent five steps guessing DNS names, and
       * when it finally guessed the right address the NetworkPolicy refused it — after which it
       * spent fourteen steps debugging its own client. A sibling leaf had to be rewritten by hand
       * as "(offline-first)" to finish at all.
       *
       * Failing to resolve is not fatal: the leaf runs with no bindings and the problems are logged,
       * which is exactly the state every leaf was in before this existed.
       */
      let bindings: ResolvedBinding[] = [];
      try {
        const needs = project?.needs ?? [];
        if (needs.length && project) {
          const dynamicTypes = await db.getBindingTypes().catch(() => []);
          const resolution = resolveBindings(
            needs,
            await db.getDeployments(),
            await db.getAppSpecs(),
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

      // Credentials are read here and travel no further than the manifest: `materializeBindings`
      // holds the kubectl, and nothing it returns is logged.
      const bindingFilesForSandbox = bindings.length
        ? await workspaces.materializeBindings(bindings).catch((err: Error) => {
          console.warn(`[ExecuteLeafActivity] ${leaf.id}: could not read binding credentials: ${err.message}`);
          return [];
        })
        : [];

      const sandboxSpec = personaWorkspace(
        persona,
        { leafId: leaf.id, ownerId: leaf.ownerId },
        // What the CODE needs. A persona brings its tools, its network and its budget; the project
        // brings the toolchain, because every persona working in a Go repository needs Go — and
        // the services it declared, which decide both what is mounted and what is reachable.
        {
          // The type decides what the deliverable is written in; a project's own language still
          // wins where one is known, because a Go repository needs Go whoever is standing in it.
          language: project?.language ?? treeType?.language,
          bindings,
          files: bindingFilesForSandbox,
          // A clone needs git. Stated as a requirement of the CHECKOUT rather than folded into the
          // language, so a research paper can keep saying it is prose — see `capableImage`.
          // Both facts about the clone, in one place: an image that HAS git, and a network that
          // can reach the forge. See `GITEA_EGRESS`.
          ...(wantsRepo ? { requires: ['git'], checkout: true } : {}),
        },
      );
      await workspaces.create(sandboxSpec);
      if (bindings.length) {
        console.log(`[ExecuteLeafActivity] ${leaf.id}: bound ${bindings.map((b) => b.name).join(', ')}`);
      }
      // Counted here rather than through countWorkspace: this activity is already going to save the
      // leaf on both exit paths, so the number rides along in `spent` and costs no extra write.
      // One of the three counted sites — see lib/leaf-usage.ts.
      workspacesCreated++;

      try {
        let taskContext = context;
        if (checkout && project) {
          /**
           * Cloned by us, then the credential is moved out of the remote URL.
           *
           * This does NOT hide the token from the agent — it lands in a file under /work, and the
           * agent can read any file it likes. Nothing can prevent that: pushing from inside the
           * sandbox requires a credential inside the sandbox. What it does prevent is the token
           * being echoed incidentally, by `git remote -v`, an error message, or a command the
           * model pastes into its summary. The controls that actually bound the risk are its
           * scope (push to this user's repos, nothing else), the egress policy (Gitea is the only
           * reachable host, so there is nowhere to send it), and revocation at teardown.
           */
          branchName = branchNameFor(leaf.id);
          /**
           * Starts from what this leaf's dependencies pushed, not from the default branch.
           *
           * The previous script cut a fresh branch straight off the clone, so a leaf ordered after
           * another began with no trace of its work — `dependsOn` ordered the work and moved none
           * of it. Measured: four dependents each spent their whole budget rebuilding a client
           * their dependency had already written.
           */
          /**
           * This leaf's OWN branch comes first, when a previous attempt left one.
           *
           * That branch was itself cut from the dependencies, so it already contains their work —
           * the dependency branches stay in the list only so a retry still picks them up if the
           * earlier attempt never managed to push.
           */
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
            // Said explicitly: the agent otherwise treats an unexpectedly populated repository as
            // someone else's code to work around, and rewrites it from scratch anyway.
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

          /**
           * ── RESUMING FROM A SAVE POINT ──
           *
           * The checkpoint artifact rides IN THE REPOSITORY, on the branch this attempt just cloned
           * — which is why resuming needs nothing more than reading a file. No new collection, no
           * new workflow argument, and no change to the `{ leafId }` contract this activity's whole
           * design rests on.
           *
           * It says what the last attempt believed it had finished, what it meant to do next, and
           * what it learned that the diff does not show. That last part is the piece a fresh clone
           * genuinely cannot reconstruct.
           */
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
          /**
           * The hand-off for work with no branch to check out.
           *
           * A dependent coding leaf inherits its dependencies through git; a research leaf has no
           * repository, so its dependencies' answers are passed as text. Same guarantee, different
           * carrier — without it `dependsOn` would order research and move none of it, which is the
           * exact failure the branch-based hand-off was built to fix.
           */
          /**
           * ── DEPENDENCY ANSWERS TRAVEL BY REFERENCE ──
           *
           * These were concatenated into this prompt, which is the system prompt, which the
           * conversation trimmer may not touch. Four dependencies came to 64,807 characters — about
           * 16,200 tokens before anything else — and the cost grew with both N and their size.
           *
           * Written to the sandbox instead, with an index in the prompt. See lib/dependency-inputs.ts.
           */
          const preparedInputs = prepareInputs(
            allLeaves
              .filter((l) => (leaf.dependsOn ?? []).includes(l.id) && l.findings?.trim())
              .map((l) => ({ leafId: l.id, title: l.title, findings: l.findings! })),
          );

          /**
           * Files when the persona can read them, inline when it cannot.
           *
           * Every persona that receives dependency findings declares `read_file` — Framer,
           * Researcher, Synthesist, Ingestor, Builder. The inline path exists for a persona that
           * does not, and shares ONE budget across inputs rather than capping each.
           */
          const canReadFiles = allowedTools(persona, [REQUIRED_TOOL]).includes(REQUIRED_TOOL);
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
            // Anything that failed to write falls back inline rather than being lost silently — an
            // index naming a file that is not there is worse than no index.
            inputsBlock = [
              buildInputIndex(landed, WORKSPACE_MOUNT),
              ...(landed.length < preparedInputs.length
                ? [buildInlineInputs(preparedInputs.filter((_, i) => !written[i]))]
                : []),
            ].filter(Boolean).join('\n\n');
          } else if (preparedInputs.length) {
            inputsBlock = buildInlineInputs(preparedInputs);
          }

          /**
           * Write first, then improve — and said in that order, emphatically.
           *
           * The gentler version of this ("write your answer to findings.md") lost a whole run:
           * measured live, the agent spent all forty steps searching and fetching, produced a
           * genuinely researched answer in its reasoning, and finished with an empty file. The work
           * happened and none of it survived, because nothing made writing the FIRST thing it did.
           *
           * The budget is stated in steps rather than as "be brief" — an instruction the agent can
           * actually check itself against, since it knows how many it has used.
           */
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
            /**
             * Said explicitly because the alternative is silent.
             *
             * The sandbox has default-deny egress, so `curl` and `wget` fail with no output rather
             * than an error the agent can read. Measured: once web_search was withdrawn halfway
             * through, the agent spent its entire remaining budget curling the same URL and getting
             * nothing back, never learning why.
             */
            'This sandbox has NO network access. curl and wget will silently return nothing —',
            'web_search and fetch_web_page are the only way out, and they stop working halfway',
            'through the run so that the second half is spent writing.',
            /**
             * What this leaf's own previous attempt wrote.
             *
             * The exact parallel of the "A PREVIOUS ATTEMPT already committed here" line a code
             * leaf gets from its branch. Without it a retry starts from an empty file while its
             * findings sit preserved on the record — so an attempt that failed only for missing
             * citations would rewrite the whole answer from scratch to add them, and probably run
             * out of steps again doing it.
             */
            /**
             * ── THE PREVIOUS ATTEMPT'S WORK, BY REFERENCE ──
             *
             * This pasted up to `MAX_FINDINGS_CHARS` of the last attempt's answer into the prompt —
             * so that the agent could write that same text back out to the same file. Into the
             * SYSTEM prompt, which `trimConversation` may not touch, so nothing could reclaim it.
             *
             * With a checkout the file is already there: `buildCheckoutScript` positions on
             * `outputBranch` when one exists, which is the branch the last attempt pushed. So say
             * where it is. Same by-value to by-reference move as dependency findings, one field
             * over, and it removes ~5,000 tokens from every retry's system prompt.
             *
             * The paste survives only where there is no checkout, because then there is no file.
             */
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

        /**
         * Resolved once, shared by recall and admission.
         *
         * `corpusEndpoints` may have to establish four port-forwards, and doing that twice in one
         * leaf pays the cold-start cost twice for the same four services.
         */
        let endsOnce: Promise<MemoryEndpoints> | undefined;
        const memoryEndpoints = () => (endsOnce ??= corpusEndpoints(db, leaf.ownerId));

        /**
         * ── ADMITTING A MEMORY, IN PLACE OF QUEUEING IT FOR A HUMAN ──
         *
         * Both writers go through here — the `save_harness_memory` tool and the post-run extractor
         * — so the rule about what may enter the bank is stated once. See lib/memory-decide.ts for
         * why a model is allowed to make this call and what it structurally cannot do.
         *
         * Every failure admits the candidate, which is exactly what the harness did before this
         * existed. Admission must never be the reason a leaf's lesson is lost.
         */
        const decideEnabled = typeof resolved.overrides.memoryDecide === 'boolean'
          ? resolved.overrides.memoryDecide
          : true;

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
                // Comparable entries only: a lesson is not a duplicate of a file listing, and
                // retired rows are history rather than something to be superseded twice.
                /**
                 * The same owner, project and category — the only entries that could be duplicates.
                 *
                 * Category alone was not enough, and the gap was a real hazard rather than noise:
                 * search returned 19 "Repository layout" facts belonging to 19 DIFFERENT projects,
                 * and `applyDecision` will act on any id it was shown. A model asked which of those
                 * the candidate duplicates could have retired another project's layout. Matching
                 * `groupKey` in memory-consolidate.ts, for the same reason.
                 */
                return found.filter((x) => x.category === m.category
                  && !x.invalidAt
                  && x.id !== m.id
                  && (x.projectId ?? '') === (m.projectId ?? '')
                  && (x.scope ?? 'global') === (m.scope ?? 'global'));
              },
              ask: async (prompt: string) => {
                const body = buildModelRequest({
                  /**
                   * ── A STRUCTURED TURN WITH REASONING OFF, AND BOTH HALVES WERE MEASURED ──
                   *
                   * The first live probe returned ADD for a candidate that was a byte-for-byte copy
                   * of a stored memory. The model had not disagreed — it never answered: 45 seconds
                   * of `reasoning_content` beginning "We need answer user's request with JSON only
                   * no prose. Need reason in English?" and an empty `content`. That parses as
                   * unusable, which falls back to ADD, so the whole gate was a no-op that looked
                   * like a working feature. Exactly how the judge failed three times.
                   *
                   * `sampling.ts` already records the fix and the measurement: with the reasoning
                   * pass off, structured output went from about one reply in eight to three out of
                   * three. It also takes this turn from 45s to about one, which is what makes it
                   * affordable to run on every memory a leaf extracts.
                   *
                   * Set through the `think` knob rather than by writing `template_vars` directly —
                   * agent-loop.ts records that hand-writing it is what lost the setting entirely on
                   * the chat path. Last, so it wins: a profile that turns reasoning on globally is
                   * expressing a preference about agent turns, not about a JSON decision.
                   */
                  turn: 'tool-turn',
                  ...(provider.kind ? { kind: provider.kind } : {}),
                  messages: [{ role: 'user', content: prompt }],
                  stream: true,
                  // A decision is one short JSON object. Generous for that, and with no reasoning
                  // pass to fund there is nothing else competing for it.
                  maxTokens: 600,
                  ...(provider.model ? { model: provider.model } : {}),
                  overrides: { ...resolved.overrides, think: false },
                }).body;

                const res = await fetch(`${baseUrl}/chat/completions`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
                  body: JSON.stringify(body),
                });
                if (!res.ok) throw new Error(`model returned ${res.status}`);

                const reply = await readStreamedReply(res as never);
                // Reasoning models put the answer on `content` and their thinking on
                // `reasoning_content`; not every engine separates them, so fall back.
                return (reply.content ?? '').trim() || (reply.reasoning ?? '').trim();
              },
            }
            : {};

          const { decision, write } = await admitMemory(gate, candidate);
          for (const item of write) await db.saveMemory(item).catch(() => undefined);

          /**
           * Indexed immediately, not at the next consolidation pass.
           *
           * Two memories extracted by the same leaf are decided one after the other, and the second
           * decision can only see the first if it is searchable by then. Without this, a leaf that
           * learns the same thing twice stores it twice — the duplication this whole mechanism
           * exists to stop.
           */
          const current = write.filter((m) => !m.invalidAt);
          if (current.length) {
            await memoryEndpoints()
              .then((ends) => indexMemories(ends, current))
              .catch(() => undefined);
          }

          console.log(`[ExecuteLeafActivity] ${leaf.id}: memory "${candidate.title}" -> ${decision.action}`);
          return decision;
        };

        /**
         * What earlier leaves on this project already established.
         *
         * The memory bank existed and was wired into the Lab only, so every leaf rediscovered the
         * same repository from scratch — one spent its whole budget twice on `ls -la`, `cat
         * package.json` and `git log` while three finished leaves had already built the thing it
         * was standing in. `buildMemoryContext` filters to active, in-scope entries, which is what
         * keeps an unreviewed inference from reaching this prompt.
         */
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

        /**
         * Said out loud, because a silent degradation here is invisible.
         *
         * `recency` means hybrid search did not answer — no stack deployed, a dead service, or the
         * 3s cap. The leaf is fine either way, which is exactly why it would otherwise never be
         * noticed that relevance retrieval has not worked for a week.
         */
        if (recalled.selected.length) {
          console.log(`[ExecuteLeafActivity] ${leaf.id}: recalled ${recalled.selected.length} memories via ${recalled.via}`);
          // Not awaited: bookkeeping for decay must not sit in front of the model call.
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
            baseUrl,
            apiKey,
            model: provider.model,
            ...(provider.kind ? { kind: provider.kind } : {}),
            ...(persona?.scope?.language ? { language: persona.scope.language as WorkspaceLanguage } : {}),
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
            ...agentRunOptions(persona, {
              taskContext: currentTaskContext,
              overrides: adopted,
              sandboxSpec,
              ...(provider.contextTokens ? { contextTokens: provider.contextTokens } : {}),
              ...(memoryContext ? { memoryContext } : {}),
              ...(project || bindings.length ? { bindingsContext: describeBindings(bindings.map(describable)) } : {}),
              ...(wantsWeb(persona) ? { web: await buildWebTools(db, leaf.ownerId) } : {}),
              ...(await resolveMcpForLeaf(db, persona, leaf)),
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
                    const verdict = assessFindings(text, outputPath, persona?.scope?.requireSources !== false);
                    current.findingsChars = text.length;
                    current.findingsOutcome = verdict.outcome;
                  }

                  const evidence = compareProgress(lastProgress, current);
                lastProgress = current;

                /**
                 * What the TREE can still afford, not just this leaf.
                 *
                 * A subtree budget a single leaf can overrun is not a budget, and this is the only
                 * place a leaf learns one exists. Absent budget means undefined headroom, which
                 * `decideExtension` reads as "unenforced" rather than as zero.
                 */
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
            /**
             * ── SAVING A RUN PARTWAY THROUGH ──
             *
             * The loop decides WHEN (see lib/leaf-checkpoint.ts); this is the HOW, and it is here
             * rather than in the loop because every line of it needs a workspace, a database, or
             * both — which the loop deliberately has neither of.
             *
             * Two shapes, one function. A persona with a repository saves by committing and
             * pushing; one without (Researcher, Framer, Synthesist) saves by re-reading its
             * deliverable and persisting it to Mongo. The second is not a lesser fallback: for
             * those personas `leaf.findings` IS the durable store, it is already written on both
             * exit paths and already fed back into the next attempt, and `assessFindings` gives a
             * better artifact than a git summary would — it names which of the three checks the
             * work currently fails.
             *
             * Never throws. A checkpoint that cannot be written must not end a run that is going
             * fine; the loop treats undefined as "did not save" and carries on without resetting.
             */
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

                /**
                 * Which of the two shapes this leaf saves in.
                 *
                 * Asked as "can this commit?" rather than by testing all three of checkout, branch
                 * and outputPath together — the first version did the latter, and a coding persona
                 * (which has a repository and no `output` file) fell into the deliverable branch
                 * and returned undefined, so the repository path never ran at all. The two
                 * conditions are about different things and must not be combined.
                 */
                // ── The deliverable-file path ────────────────────────────────────────────────
                // Written as two separate checks rather than one combined condition, so the
                // narrowing below is real and so the two questions stay distinguishable.
                if (!checkout || !branchName) {
                  // Nothing durable to write to: no checkout, and no file this persona promised.
                  if (!outputPath) return undefined;
                  const text = await workspaces.readFile(leaf.id, outputPath).catch(() => '');
                  const verdict = assessFindings(text, outputPath, persona?.scope?.requireSources !== false);

                  const artifact = buildCheckpointArtifact({
                    ...common,
                    findings: {
                      path: outputPath,
                      outcome: verdict.outcome,
                      reason: verdict.reason,
                      chars: text.length,
                    },
                  });

                  /**
                   * Persisted immediately, not at the end. That is the entire point: the next
                   * attempt reads `findings` back out of Mongo, so a run killed after this line
                   * resumes from real work rather than from nothing.
                   */
                  const fresh = await currentLeaf();
                  if (fresh && text.trim()) {
                    await db.saveLeaf({
                      ...fresh,
                      findings: text.slice(0, MAX_FINDINGS_CHARS),
                      updatedAt: new Date().toISOString(),
                    });
                  }
                  /**
                   * A checkpoint doubles as the progress BASELINE.
                   *
                   * `compareProgress` needs two readings, and the extension probe only runs when a
                   * ceiling is hit — so without this the FIRST ceiling has nothing to compare
                   * against and can never grant an extension, however well the run is going. The
                   * checkpoint has already gathered exactly this data for its artifact, so the
                   * baseline is free.
                   */
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

                // ── The repository path ──────────────────────────────────────────────────────
                const base = project?.defaultBranch || 'main';
                const progress = await workspaces
                  .exec(leaf.id, buildProgressScript(), 60_000, [base])
                  .then((r) => parseProgress(r.stdout))
                  .catch(() => ({ commits: '', changed: '' }));

                const artifact = buildCheckpointArtifact({
                  ...common,
                  repo: { branch: branchName, commits: progress.commits, changed: progress.changed },
                });

                // Doubles as the progress baseline — see the findings path above for why.
                lastProgress = {
                  at: { step: 0, tokens: tokensUsedAtCheckpoint },
                  commits: progress.commits ? progress.commits.split('\n').filter(Boolean).length : 0,
                  changedLines: Number(/(\d+) insertions?\(\+\)/.exec(progress.changed)?.[1] ?? 0),
                };

                // Written into the repository BEFORE the commit that captures it.
                await workspaces.writeFile(leaf.id, `/work/repo/${artifactPath}`, artifact);

                const saved = await workspaces
                  .exec(leaf.id, buildCheckpointScript(), 120_000, [branchName, artifactPath])
                  .then((r) => parseCheckpointResult(r.stdout))
                  .catch(() => undefined);

                /**
                 * ── THE ORPHANING HAZARD ──
                 * `outputBranch` MUST be recorded the moment a push is confirmed. `buildCheckoutScript`
                 * only positions the next attempt on this leaf's branch when Mongo holds it — so
                 * without this write, attempt 2 branches off the DEFAULT branch instead,
                 * `buildPushScript`'s `|| true` swallows the resulting non-fast-forward failure, and
                 * `git ls-remote` then confirms the branch that is already there and reports
                 * `PUSHED:` anyway. The leaf would report an outputBranch containing only this
                 * checkpoint and silently lose everything attempt 2 did.
                 *
                 * Re-read before writing, because this activity has been running for minutes and
                 * `saveLeaf` is a full replace.
                 */
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

                // Logged on SUCCESS too, not only on failure. A checkpoint is a rare, expensive,
                // state-changing event that is otherwise completely silent — and "did it actually
                // fire?" was the first question asked of it live.
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

        // ── VALIDATOR TURN ──
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

        /**
         * The run's own verdict, kept where the catch can reach it.
         *
         * `summary` is the readable form and `stoppedBecause` is the actionable one. A budget stop
         * is deliberately NOT a self-diagnosis: it may go differently with another attempt, whereas
         * "I am repeating myself" will not.
         */
        diagnosis = run.summary;
        if (run.stoppedBecause && run.stoppedBecause !== 'budget') selfDiagnosed = run.stoppedBecause;

        // Tokens are recorded on the leaf whether or not the work succeeded — a failed attempt
        // costs exactly as much as a successful one and must count against the root's budget, or
        // a leaf that fails repeatedly becomes the cheapest thing on the board.
        /**
         * `tokens` is what a metered API bills — prompt plus completion, re-read every turn — so it
         * is the number budgets enforce on. `completionTokens` is what the agent actually GENERATED,
         * and it is the only one of the two that says anything about the work: a full-context turn
         * costs ~15k tokens whether it wrote a file or a sentence. Recorded separately so a leaf's
         * cost and a leaf's output stop being the same figure.
         */
        /**
         * Every addend is coalesced, including the ones the type says are required.
         *
         * `NaN` is the worst possible value to write here. It propagates through `aggregateUsage`
         * to the whole subtree, and every comparison in `budgetExceeded` against `NaN` is FALSE —
         * so a single undefined addend does not produce a visibly broken number, it silently turns
         * the budget off. A loop result assembled by an older caller, a mock, or a future field
         * that has not been backfilled must degrade to "counted nothing", never to that.
         */
        const spent = {
          ...(leaf.usage ?? {}),
          tokens: (leaf.usage?.tokens ?? 0) + (run.tokensUsed ?? 0),
          completionTokens: (leaf.usage?.completionTokens ?? 0) + (run.completionTokensUsed ?? 0),
          workspaces: (leaf.usage?.workspaces ?? 0) + workspacesCreated,
        };

        /**
         * The trace, written here rather than on either exit path.
         *
         * Before the verification, the push and the merge — all of which can fail — because the run
         * a failure needs explaining is exactly the run whose record must survive. Writing it at
         * the end would lose it precisely when it matters.
         *
         * Never fatal: a leaf that did the work and could not store its diary has still done the
         * work, and throwing here would retry the whole agent run.
         */
        if (run.trace?.length) {
          // Replaces what the live appends accumulated: same turns, trimmed to the storage budget.
          const fitted = trimTrace(run.trace);
          await db.saveLeafTrace({
            id: leaf.id,
            ownerId: leaf.ownerId,
            branchId: leaf.branchId,
            steps: redactDeep(fitted.steps, secretsInPlay()),
            ...(fitted.trimmed ? { trimmed: true } : {}),
            totalSteps: run.trace.length,
            tokensUsed: run.tokensUsed,
            // Where the rest of the run went. `steps` is only the window since the last reset, so
            // without this a checkpointed trace quietly describes a fraction of itself.
            ...(run.checkpoints?.length ? { checkpoints: run.checkpoints } : {}),
            createdAt: new Date().toISOString(),
          }).catch((err) => {
            console.warn(`[ExecuteLeafActivity] leaf ${leaf.id}: could not store trace: ${err?.message}`);
          });
        }

        /**
         * What actually reached the remote — asked of Gitea, not of the agent.
         *
         * Two distinct jobs: an agent that commits and forgets to push leaves the work in a pod
         * about to be destroyed, so this pushes on its behalf; and `outputBranch` is recorded only
         * when `git ls-remote` confirms the branch, because a branch name that cannot be checked
         * out would strand every dependent leaf while looking exactly like a successful hand-off.
         */
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

        /**
         * ── THE REPOSITORY GETS THE LAST WORD ──
         *
         * `run.succeeded` is the agent calling `finish(succeeded: true)` — a claim about its own
         * work. Observed wrong in both directions: a leaf reported creating a file it had not
         * committed and was marked succeeded, and a leaf capped at 7 steps failed three attempts
         * while its branch accumulated all nine expected files with nine passing tests.
         *
         * Run for BOTH outcomes, deliberately. Verifying only the successes would leave exactly the
         * second case unrescued.
         */
        /**
         * A research leaf is proved by having produced an answer.
         *
         * Read from the sandbox before it is destroyed, and read rather than asked for: the agent's
         * summary is a claim about the work, while the file either exists with something in it or
         * does not. It is a weak check by design — the same strength as the artifact check it
         * replaces, and it says nothing about whether the answer is any good. What it does catch is
         * the failure that actually happens, which is a leaf reporting a thorough investigation and
         * leaving nothing behind.
         */
        let findings = '';
        if (outputPath) {
          findings = await workspaces.readFile(leaf.id, outputPath).catch(() => '');
        }

        /**
         * ── ONE VERIFICATION PATH, NOT A BRANCH PER CATEGORY ──
         *
         * Every check that APPLIES runs, and what applies is read off what was declared: a persona
         * that named an output has that output checked; a leaf with a test command has it run; a
         * leaf that promised files has them looked for. Nothing consults a category, because a
         * category was only ever a guess at which of these to trust.
         *
         * Which strategy is actually the right one is an open question. Every outcome is recorded
         * on the leaf (see `checks`) so it can be answered with numbers later rather than by
         * picking now.
         */
        let verify: VerifyResult = { outcome: 'unverified', output: '' };
        // Whether the leaf chose this check or inherited the fallback. Decides, further down,
        // whether a pass on an unchanged repository counts as evidence — see `evidenceOf`.
        const isDocumentLeaf = Boolean(outputPath || !wantsRepo);
        const activeRecipe = leaf.validationContract
          ?? (isDocumentLeaf
            ? (treeType?.validationRecipe?.type === 'document' ? treeType.validationRecipe : undefined)
            : treeType?.validationRecipe);
        const declaredVerify = Boolean((producesCode && leaf.verifyCommand?.trim()) || activeRecipe || finalValidationSummary);
        const verifyCommand = producesCode ? (leaf.verifyCommand?.trim() || defaultVerifyCommand(workLanguage)) : '';

        if (outputPath) {
          const verdict = assessFindings(findings, outputPath, persona?.scope?.requireSources !== false);
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

        /**
         * The check that works for work with no tests to run.
         *
         * Running a suite covers code and nothing else, so a research, docs or config leaf came
         * back unverified and its claim was believed — leaving the original failure live for
         * exactly the work that cannot be tested. This asks only whether the promised file is
         * there, committed and non-empty, and says nothing about whether it is any good.
         *
         * Run AFTER the push below, so "committed" means committed. `pushBack` commits whatever the
         * agent left uncommitted, and checking before it would fail a leaf over a file our own
         * rescue was about to commit a moment later.
         */
        const pushedBranch = await pushBack();
        // `expects` names repository paths, so it only means anything where there is one. A planner
        // that promises files to a persona with no checkout is asking for a check that can only fail.
        /**
         * Artifact checks follow the CHECKOUT, not the code flag.
         *
         * `expects` names repository paths, so it means something wherever there is a repository —
         * and for a document leaf "was findings.md actually committed" is exactly the check that was
         * missing. Only the test run and the Dockerfile check remain code-only.
         */
        if (wantsRepo && leaf.expects?.length) beat({ phase: 'artifacts' });
        const artifacts = wantsRepo && leaf.expects?.length
          ? await workspaces
              .exec(leaf.id, buildArtifactCheckScript(leaf.expects, project?.defaultBranch || 'main', conventions), 60_000)
              .then((r) => parseArtifactResult(r.stdout))
              .catch(() => ({ outcome: 'unknown' as const, missing: [], moved: [] }))
          : { outcome: 'none' as const, missing: [], moved: [] };

        // Logged rather than swallowed: a planner that guesses the layout wrong is worth noticing,
        // and the leaf passing quietly would hide it forever.
        if (artifacts.moved.length) {
          console.log(`[ExecuteLeafActivity] leaf ${leaf.id}: declared artifacts found elsewhere — ${artifacts.moved.join(', ')}`);
        }
        if (artifacts.outcome === 'stale') {
          console.log(`[ExecuteLeafActivity] leaf ${leaf.id}: declared artifacts already present and unchanged — ${artifacts.missing.join(', ')}`);
        }

        /**
         * ── THE DOCKERFILE, WHICH NOTHING ELSE READS ──
         *
         * A leaf rewrote a working Dockerfile to `COPY package.json` then `RUN npm ci`, which
         * cannot succeed without the lockfile. It was marked succeeded AND verified, because
         * verification runs the test suite and no test reads the Dockerfile. Every build then
         * failed, and the deploy retried 54 times over ninety minutes before anybody noticed.
         *
         * So the one artifact the deploy depends on is checked too. Static, not a build: the
         * sandbox has no image builder, and this catches the specific ways a Dockerfile is
         * definitely broken rather than proving one works.
         */
        let dockerProblems = '';
        if (producesCode) {
          const dockerfile = await workspaces.readFile(leaf.id, '/work/repo/Dockerfile').catch(() => '');
          if (dockerfile.trim()) {
            const listing = await workspaces
              .exec(leaf.id, 'cd /work/repo && git ls-files')
              .then((r) => String(r.stdout ?? '').split('\n').map((f) => f.trim()).filter(Boolean))
              .catch(() => [] as string[]);
            const ignore = await workspaces.readFile(leaf.id, '/work/repo/.dockerignore').catch(() => '');
            /**
             * Whether the project has dependencies at all, so a multi-stage build that copies
             * node_modules out of a stage installing nothing can be judged. Undefined when the
             * manifest cannot be read — unknown is not "none", and guessing would fire on every
             * correct multi-stage build.
             */
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

        /**
         * A pass the leaf did not earn is downgraded here, once it is known whether it changed
         * anything. Applied to the repository check only: a research leaf's findings are assessed
         * against what it actually wrote, and never depended on a commit.
         */
        const earned = outputPath
          ? verify.outcome
          : evidenceOf(verify.outcome, { declaredCommand: declaredVerify, changed: Boolean(pushedBranch) });
        if (earned !== verify.outcome) {
          console.warn(
            `[ExecuteLeafActivity] leaf ${leaf.id}: default suite passed but nothing was committed — recording unverified, not verified`,
          );
        }

        const combined = combineVerification(earned, artifacts.outcome);
        /**
         * A Dockerfile that cannot build fails the leaf, whatever the tests said.
         *
         * The same principle as the repository getting the last word over the agent's claim: a
         * green suite is not evidence about an artifact the suite never reads.
         */
        const settled = dockerProblems ? 'failed' : decideStatus(run.succeeded, combined);

        /**
         * ── EVERY LAYER'S ANSWER, NOT JUST THE WORD THEY COLLAPSE TO ──
         *
         * A comment a few hundred lines up has promised this for a while: "every outcome is
         * recorded on the leaf so it can be answered with numbers later rather than by picking
         * now". It never was. The board shows one tick, and a leaf with a green suite and a missing
         * declared artifact looks identical to one with neither problem.
         *
         * Small enough to live on the leaf itself — the bulky counterpart goes on the trace below.
         */
        const checks: LeafChecks = {
          verify: { ...(verifyCommand ? { command: verifyCommand } : {}), outcome: verify.outcome },
          artifacts: { outcome: artifacts.outcome, ...(artifacts.missing.length ? { missing: artifacts.missing } : {}) },
          ...(dockerProblems ? { docker: { problems: true } } : {}),
          ...(outputPath ? { findings: { outcome: verify.outcome } } : {}),
          combined,
          settled,
        };

        /**
         * ── THE ARTIFACTS THEMSELVES, BEFORE THE SANDBOX GOES ──
         *
         * Captured here because this is the last moment they exist: the `finally` destroys the pod,
         * and `/work` is an emptyDir. Two consumers, one of which does not exist yet:
         *
         *   · `failure-review.ts` diagnoses failures and has never been given a diff. "Did the
         *     tests exercise the new code" has been unanswerable for every leaf ever run here.
         *   · A judge, if one is ever asked. The abandoned harness-v2 branch scored work against a
         *     hardcoded `gitDiff: '+export const feature = true;'` — this field is what makes that
         *     particular failure impossible rather than merely discouraged.
         *
         * Never fatal, and deliberately after the status is decided: evidence is for explaining a
         * verdict, never for reaching one.
         */
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

        /**
         * What this attempt learned, for the leaves that come after it.
         *
         * Written on BOTH outcomes: the repository layout is worth knowing whether or not this
         * particular leaf finished, and a failure is exactly when there is something to record.
         *
         * Best-effort throughout — a leaf that did its work must not be failed because the memory
         * bank was unreachable.
         */
        try {
          const tracked = await workspaces
            /**
             * Vendored directories excluded before the head, not after.
             *
             * `git ls-files | head -60` returns the FIRST sixty paths alphabetically, and
             * `node_modules/` sorts near the front — so one `npm install` that got committed turned
             * this listing into sixty entries of `node_modules/@hono/node-server/dist/...`. That
             * listing becomes the "repository layout" memory, which is injected into every prompt
             * for the project: measured at ~1,400 characters of vendored file names per request,
             * describing nothing anyone wrote.
             *
             * New repositories get a .gitignore now (GiteaService.ensureGitignore), but the ones
             * already polluted are still out there, and a repo can always vendor deliberately.
             */
            .exec(
              leaf.id,
              // `.koala/` holds the harness's own checkpoint artifacts. They are committed to the
              // repository on purpose — that is what makes a save point survive the pod — but they
              // are not part of the project's layout, and letting them into the extracted
              // "repository layout" memory would teach every future prompt about bookkeeping.
              "cd /work/repo 2>/dev/null && git ls-files "
              + "| grep -vE '^(node_modules|vendor|\\.venv|venv|dist|build|__pycache__|\\.koala)/' | head -60",
              60_000,
            )
            .then((r) => r.stdout.split('\n').map((l) => l.trim()).filter(Boolean))
            .catch(() => [] as string[]);

          const learned = extractLeafMemories({
            /**
             * `project.id`, not `leaf.projectId` — the leaf record only gains its projectId in the
             * save BELOW, so reading it here produced a project-scoped memory with no project on
             * it, which `buildMemoryContext` then filtered out of every future prompt. Written,
             * active, and unreadable.
             */
            leaf: { ...leaf, ...(project ? { projectId: project.id } : {}) },
            trackedFiles: tracked,
            summary: run.summary,
            succeeded: settled === 'succeeded',
            missingArtifacts: artifacts.missing,
            ...(verify.output ? { verifyOutput: verify.output } : {}),
          });

          if (learned.length) {
            const { save, invalidate } = supersede(await db.getMemories(leaf.ownerId), learned);
            // Retired first: the replacement carries the same title, and leaving both current for
            // even a moment is how a prompt ends up with two contradictory file listings.
            for (const item of invalidate) await db.saveMemory(item).catch(() => undefined);

            /**
             * ── ADMITTED, NOT JUST WRITTEN ──
             *
             * `supersede` only knows one rule: a new "Repository layout" retires the old one for the
             * same project. Everything else it lets straight through, which is why the bank filled
             * with five copies of "Promised a file it did not deliver" — a title it has never heard
             * of. `admit` asks the question `supersede` structurally cannot: is this already known?
             *
             * The layout fact goes through it too. It has usually just been retired by the line
             * above, so its nearest neighbours are its own predecessors and the honest answer is
             * ADD — but running it through the same path keeps one rule about what enters the bank
             * rather than two.
             */
            for (const item of save) await admit(item);
          }
        } catch (err) {
          console.warn(`[ExecuteLeafActivity] could not record what leaf ${leaf.id} learned: ${(err as Error).message}`);
        }

        if (settled === 'failed') {
          /**
           * ── A FAILED ATTEMPT KEEPS ITS WORK ──
           *
           * This activity's whole retry design is that attempt N+1 reads a database attempt N
           * changed. That was true of the failure log and false of the work itself: the pod was
           * destroyed and the next attempt cloned an empty repository, so three attempts produced
           * one attempt's progress three times over.
           *
           * Measured on "Implement JSON config parser module": three attempts, 91,818 tokens, and
           * each one's final commands were still `mkdir` and `write package.json` — it never got
           * past scaffolding because it rebuilt the scaffolding every time.
           *
           * Pushing a partial, possibly broken state is the deliberate trade. The next attempt is
           * told what happened and can see the tree; inheriting half-built work it can read beats
           * re-deriving it blind, and the observed failure is running out of steps mid-setup rather
           * than corrupting anything.
           */
          const partial = pushedBranch;
          /**
           * What the attempt LEFT, not what it typed.
           *
           * The loop's summary reports the last three shell commands, which tells the retry
           * nothing about whether there is anything to build on. Read after the push so it
           * describes the state the next attempt will actually clone.
           */
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
            // Kept even on a failure, for the same reason a partial branch is: a half-written
            // answer is what the next attempt should continue from rather than rediscover.
            ...(findings.trim() ? { findings: findings.slice(0, MAX_FINDINGS_CHARS) } : {}),
            updatedAt: new Date().toISOString(),
          });
          // Thrown so the failure lands in the catch below, which is the ONE place that records an
          // attempt. A second recording path is how histories end up inconsistent.
          throw new Error([
            // The agent's own claim is reported when it CONTRADICTS the check, because "it said it
            // was done" is the most useful thing the next attempt can know about the last one.
            verify.outcome === 'failed' && run.succeeded
              ? `The agent reported success, but the checks failed. Its report: ${run.summary}`
              : run.summary,
            ...(verify.outcome === 'failed' ? [`Verification failed (\`${verifyCommand}\`):\n${verify.output}`] : []),
            ...(artifacts.outcome === 'missing'
              ? [`These files were required and are not committed: ${artifacts.missing.join(', ')}. Create them and commit before finishing.`]
              : []),
            // With the fix, not just the fault — the next attempt should not have to rediscover
            // that `npm ci` needs a lockfile in the build context.
            ...(dockerProblems ? [dockerProblems] : []),
            ...(partial ? [`Work so far is committed on ${partial} and will be waiting at /work/repo next attempt.`] : []),
            ...(state ? [`State of the repository when this attempt ended:\n${state}`] : []),
          ].join('\n\n'));
        }

        const outputBranch = pushedBranch;

        /**
         * Verified work lands on the default branch.
         *
         * Without this a leaf pushed `koala/<id>` and stopped, so every repository's main held
         * nothing but its initial README while the actual work sat on a branch nobody would think
         * to look at — twelve projects that read as empty.
         *
         * Gated on verification passing, which is what makes `verified` mean something concrete.
         * A conflict or a rejected push is not a failure of the leaf: the work is safe on its own
         * branch, and forcing a resolution here would mean guessing at someone else's changes.
         */
        let merged = false;
        /**
         * A Dockerfile that cannot build never reaches the default branch.
         *
         * This check originally only set the leaf's STATUS, and the merge is gated on `combined` —
         * so a leaf with passing tests and an unbuildable Dockerfile was marked failed and merged
         * anyway. The broken file landed on main, the push webhook fired, and the pipeline built
         * it. Catching a fault and then letting it through is worse than not catching it, because
         * it reads as covered.
         */
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
        // The summary is persisted, not just returned: a caller that reads the workflow result is
        // not the same as a board someone can look at.
        const freshOnSuccess = await currentLeaf();
        if (freshOnSuccess) await db.saveLeaf({
          ...freshOnSuccess, usage: spent, status: 'succeeded', column: 'review', checks,
          // The summary lands on the record and is read by a human; the failure text below is read
          // by the NEXT attempt. Both are places a credential would outlive the run.
          ...(run.summary ? { summary: redactSecrets(run.summary.slice(0, 8000), secretsInPlay()) } : {}),
          /**
           * Whether anything actually checked this, so the board can say "verified" or "claimed"
           * rather than showing the same green tick for both. An unverified success is still a
           * success — most leaves are not test-shaped — it is just not evidence.
           */
          verified: combined === 'passed',
          // Recorded so the board can point at the default branch when the work landed there, and
          // at the leaf's own branch when it did not.
          merged,
          // Recorded so a later leaf can find the work, and so the board can link to it.
          ...(project ? { projectId: project.id } : {}),
          ...(outputBranch ? { outputBranch } : {}),
          // A research leaf's actual output. Stored here because there is no repository holding it.
          ...(findings.trim() ? { findings: findings.slice(0, MAX_FINDINGS_CHARS) } : {}),
          updatedAt: now,
        });
        return { leafId: leaf.id, tokensUsed: run.tokensUsed, summary: run.summary };
      } finally {
        // Always. The pod holds CPU and memory, and reapStale is a safety net for crashes, not the
        // normal path.
        await workspaces.destroy(leaf.id).catch(() => undefined);
        // A push token outliving its sandbox is a credential nobody is watching.
        if (repos && checkout) await repos.revokeCheckout(leaf.ownerId, checkout.tokenName).catch(() => undefined);
      }
    } catch (err: any) {
      /**
       * Did this attempt leave ANYTHING behind — a commit, or a written deliverable?
       *
       * Read from the leaf as it now stands rather than from the run's report, for the same reason
       * `decideStatus` exists: the claim and the result are different things, and only one of them
       * is checkable. `outputBranch` is set from `git ls-remote`, so it means the remote confirmed
       * a branch; `findings` means a file was read back with content in it.
       *
       * Never fatal — a leaf that has been deleted mid-run simply reports nothing produced, which
       * is also true.
       */
      const after = await currentLeaf().catch(() => undefined);
      const produced = Boolean(after?.outputBranch || after?.findings?.trim());

      // Written BEFORE rethrowing, so Temporal's retry re-reads a database this attempt changed.
      const attempts: LeafAttempt[] = [
        ...priorFailures,
        {
          // Read from the activity context, not passed in: an argument would be baked into
          // workflow history at the first call and stay 1 forever, mislabelling every retry.
          // Temporal counts attempts from 1; LeafAttempt counts from 0.
          attempt: Math.max(0, attemptNumber - 1),
          error: redactSecrets(String(err?.message ?? err).slice(0, 2000), secretsInPlay()),
          failedAt: new Date().toISOString(),
          produced,
        },
      ];
      /**
       * A leaf Temporal is about to retry is not FAILED — it is still running.
       *
       * ── WHAT THE BOARD SHOWED ──
       * Every attempt wrote `status: 'failed'`, including the ones with retries left, so a leaf that
       * failed twice and succeeded on the third showed a red failed icon for most of its life and
       * flipped to verified at the end. The UI was rendering the record faithfully; the record
       * conflated "failed" with "failed, trying again", which are not the same thing to anyone
       * watching.
       *
       * The same distinction the rest of this codebase insists on — `failed` versus `unhealthy`,
       * `verified` versus `claimed` — missing from the state a person actually stares at.
       *
       * `attempts` is written either way, so nothing is hidden: LeafDetail lists every failure with
       * its error, and the count is what makes a struggling leaf visible while it struggles.
       *
       * Read from the activity context, so it reflects the real attempt rather than a number baked
       * into workflow history. The retry policy sets no nonRetryableErrorTypes, so reaching the cap
       * is the only thing that stops another attempt.
       */
      const nextStatus = statusAfterFailure(attemptNumber, MAX_LEAF_ATTEMPTS);
      // Already the fresh read, so it answers "still there?" and "what does it say now?" at once.
      const latest = await currentLeaf();
      if (latest) {
        await db.saveLeaf({
          ...latest,
          attempts,
          status: nextStatus,
          /**
           * ── THE FIELD THAT WAS EMPTY ON EVERY FAILURE ──
           *
           * `summary` was written only on the success path, so nine failed leaves across two
           * projects all read `summary: (none)`. The reason existed — the loop writes an excellent
           * one, and `attempts[].error` holds it — but the field a human and the judge actually read
           * was blank, which is why none of those failures were diagnosed until they were pulled out
           * of Mongo by hand.
           */
          ...(diagnosis ? { summary: redactSecrets(diagnosis.slice(0, 8000), secretsInPlay()) } : {}),
          updatedAt: new Date().toISOString(),
        });
      }

      /**
       * Tell the conversation.
       *
       * Nothing wrote to the branch when a leaf failed, so the transcript ended wherever planning
       * stopped and everything after — three attempts, 91,818 tokens, a permanently stranded
       * dependent — happened where the user was not looking and the model could not see. Asked how
       * it was going, the model reported on a board it last saw before any work ran.
       *
       * Best-effort, and deliberately after the leaf is saved: the failure record is what a retry
       * reads, and it must not be lost because the branch write failed.
       */
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

      /**
       * ── STOP RETRYING A LEAF THAT IS NOT PRODUCING ──
       *
       * Two attempts in a row that left NOTHING — no commit, no written deliverable — is not bad
       * luck. thrash.ts records the shape: every run that eventually worked began producing early,
       * and the leaf that failed three times had written nothing at all across forty turns each of
       * `ls`, `cat` and `git status`. It was not short of budget. It was blocked on something the
       * agent could not see, and a third attempt costs real tokens to learn that again.
       *
       * `MAX_LEAF_ATTEMPTS` stays at 3 — with checkpoints, attempts now COMPOSE rather than repeat,
       * so the cap is worth more than it was. What changes is that a barren streak stops early.
       * Temporal cannot raise `maximumAttempts` at runtime, so refusing another attempt is the only
       * lever the retry policy gives, and it turns "spend the budget again" into "surface it to a
       * human" — which is what POST /api/leaves/:id/review exists for.
       */
      /**
       * ── A DIAGNOSIS IS NOT A TRANSIENT FAILURE ──
       *
       * `barrenStreak` refuses another attempt when two produced nothing. Every leaf that failed in
       * the last two projects produced SOMETHING — a commit, a findings file — so it never fired,
       * and each of them retried the full three times. All nine were diagnosed correctly on their
       * first attempt ("This is a loop, not progress") and then reproduced the same loop twice more.
       * One Synthesist recorded the identical sentence three times.
       *
       * The distinction that was missing: running out of budget or crashing may go differently next
       * time; concluding "I am repeating myself" will not. Retrying that spends a full budget to
       * re-derive an answer the harness already had, which is roughly two thirds of what those two
       * projects burned on failures.
       *
       * Budget stops stay retryable — a leaf that ran out with checkpoints resumes and composes,
       * which is what MAX_LEAF_ATTEMPTS is for.
       */
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
