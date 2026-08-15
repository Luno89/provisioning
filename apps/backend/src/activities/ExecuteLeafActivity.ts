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
import { createDatabase } from '../lib/db-interface.js';
import { failureContext, type Branch, type Leaf, type LeafAttempt } from '../lib/leaves.js';
import { WorkspaceService } from '../services/WorkspaceService.js';
import { createModelService } from '../lib/model-wiring.js';
import { runAgentLoop } from '../lib/agent-loop.js';
import { resolveConfig } from '../lib/personas.js';
import { flattenPersona, usesRepo, personaWorkspace } from '../lib/persona-scope.js';
import type { WorkspaceLanguage } from '../lib/workspace-spec.js';
import { GiteaService } from '../services/GiteaService.js';
import { InfrastructureService } from '../services/InfrastructureService.js';
import { ProjectRepoService } from '../services/ProjectRepoService.js';
import { v4 as uuidv4 } from 'uuid';
import type { ProjectMetadata } from '../lib/types.js';
import { resolveLeafProject } from '../lib/leaf-project.js';
import { primaryProjectId, withProject } from '../lib/trees.js';
import { trimTrace } from '../lib/leaf-trace.js';
import {
  branchNameFor, baseBranchesFor, buildCheckoutScript, buildPushScript, parsePushedBranch,
  buildRepoStateScript, summariseRepoState, buildMergeScript, parseMergeResult,
} from '../lib/leaf-checkout.js';
import {
  defaultVerifyCommand, buildVerifyScript, parseVerifyResult, decideStatus, type VerifyResult,
} from '../lib/leaf-verify.js';
import {
  buildArtifactCheckScript, parseArtifactResult, combineVerification,
} from '../lib/leaf-artifacts.js';
import { buildMemoryContext } from '../lib/memory-store.js';
import { buildFailureNotice, withNotice } from '../lib/branch-notice.js';
import { MAX_LEAF_ATTEMPTS } from '../lib/leaves.js';
import { extractLeafMemories, supersede } from '../lib/leaf-memory.js';
import { assessFindings } from '../lib/research-verify.js';
import { WEB_TOOL_NAMES } from '../lib/leaf-tools.js';
import { buildWebTools } from '../lib/web-tools-wiring.js';
import { agentRunOptions, wantsWeb } from '../lib/agent-run.js';

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

export interface ExecuteLeafResult {
  leafId: string;
  /** Tokens consumed by this attempt, folded into the root's budget by the caller. */
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

export async function ExecuteLeafActivity(args: ExecuteLeafArgs): Promise<ExecuteLeafResult> {
  /**
   * Falls back to 1 outside an activity context, so the function stays callable from a test.
   *
   * Caught rather than guarded with `?.`: `Context.current` is always defined and THROWS when there
   * is no activity around it, so the optional call this used to be protected nothing and made the
   * function unreachable from anywhere but a worker.
   */
  let attemptNumber = 1;
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
    const context = buildLeafContext(leaf, priorFailures);

    /**
     * Whether this leaf still exists, asked immediately before every write.
     *
     * Deleting a branch cancels its leaves' workflows and removes the rows, but an activity already
     * inside the agent loop does not stop — and `saveLeaf` is an upsert, so its final write
     * RECREATES the leaf pointing at a branch that is gone. Observed live: an orphan reappeared in
     * the tree under a derived node, and deleting the branch again could not remove it because the
     * branch was already deleted.
     *
     * A read before each write rather than one check up front: the whole race is that the delete
     * lands DURING the run, so a check at the start would answer the wrong question.
     */
    const stillExists = async () => (await db.getLeaves()).some((l: Leaf) => l.id === leaf.id);

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
      // Where this persona says its deliverable goes. Absent means it produces files, not an answer.
      const outputPath = persona?.scope?.output;

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
       * A research leaf gets no repository at all.
       *
       * Its deliverable is an answer, not a file. Provisioning a repo, cutting a branch and pushing
       * for it was overhead that also broke its verification: `defaultVerifyCommand` looks for a
       * test suite it will never have, so it came back unverified and the agent's own claim was
       * believed. Its answer is stored on the leaf record instead — see `findings`.
       */
      let project: ProjectMetadata | undefined;
      if (!wantsRepo) {
        console.log(`[ExecuteLeafActivity] leaf ${leaf.id}: persona works without a repository`);
      } else try {
        const projectRepos = new ProjectRepoService(db, gitea, process.env.JWT_SECRET ?? '');
        /**
         * The tree's repository, when this leaf's conversation belongs to one.
         *
         * Looked up here rather than inside resolveLeafProject so that module still knows nothing
         * about trees or branches. Without it every branch of one effort gets its own repository,
         * and continuing an effort in a new conversation starts again from an empty repo.
         */
        const branchOf = (await db.getBranches()).find((b) => b.id === leaf.branchId);
        const treeOf = branchOf?.treeId
          ? (await db.getTrees()).find((t) => t.id === branchOf.treeId)
          : undefined;

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
        try {
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
       * The container comes off the persona record, and from nothing else.
       *
       * This used to derive the image from the leaf's language and the network from whether a
       * checkout had happened — so the same persona got a different sandbox depending on the work
       * it was attached to. The leaf's own language is a fallback for a persona that does not name
       * one, and the Gitea rule is added only when a repository is actually being cloned into it.
       */
      /**
       * The container, entirely off the record.
       *
       * Nothing is contributed here — not the image, not the network. A persona that works in a
       * repository declares the egress its clone needs, because "can reach Gitea" is a fact about
       * that persona's environment, not about the code that happened to start it. The last version
       * of this injected that rule when a checkout existed, which meant the same persona had a
       * different network depending on which caller reached it.
       *
       * A persona that needs a different toolchain is a different persona — `basedOn` makes that a
       * record with one changed field rather than a copy.
       */
      await workspaces.create(personaWorkspace(
        persona,
        { leafId: leaf.id, ownerId: leaf.ownerId },
        // What the CODE needs. A persona brings its tools, its network and its budget; the project
        // brings the toolchain, because every persona working in a Go repository needs Go.
        { language: project?.language },
      ));

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
          ].join('\n');
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
          const priorFindings = allLeaves
            .filter((l) => (leaf.dependsOn ?? []).includes(l.id) && l.findings?.trim())
            .map((l) => `### ${l.title}\n${l.findings!.trim()}`);

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
            ...(leaf.findings?.trim()
              ? [
                  '',
                  `A PREVIOUS ATTEMPT wrote this. Start by writing it back to ${outputPath}, then fix`,
                  'what the failure above says was wrong with it. Do not start over.',
                  '',
                  leaf.findings.trim(),
                ]
              : []),
            ...(priorFindings.length
              ? ['', 'What the work this depends on already found:', ...priorFindings]
              : []),
          ].join('\n');
        }

        /**
         * What earlier leaves on this project already established.
         *
         * The memory bank existed and was wired into the Lab only, so every leaf rediscovered the
         * same repository from scratch — one spent its whole budget twice on `ls -la`, `cat
         * package.json` and `git log` while three finished leaves had already built the thing it
         * was standing in. `buildMemoryContext` filters to active, in-scope entries, which is what
         * keeps an unreviewed inference from reaching this prompt.
         */
        const memoryContext = buildMemoryContext(
          await db.getMemories(leaf.ownerId).catch(() => []),
          project?.id,
        );

        const run = await runAgentLoop({
          baseUrl,
          apiKey,
          model: provider.model,
          ...(provider.kind ? { kind: provider.kind } : {}),
          /**
           * What the container ACTUALLY is.
           *
           * Drives the prompt's description of the available toolchain, and comes from the same
           * field that chose the image — so the agent cannot be told it has Go while sitting in the
           * base image, which it would otherwise discover only when a command failed.
           */
          ...(persona?.scope?.language ? { language: persona.scope.language as WorkspaceLanguage } : {}),
          /**
           * Kept, so a finished run can be replayed.
           *
           * The loop has always been able to produce this and only the Lab ever asked. A leaf kept
           * a one-line summary, so every diagnosis of a failing leaf so far has meant re-running it
           * by hand with a probe — which only works while the cause is still reproducible.
           *
           * It does NOT go on the leaf; see lib/leaf-trace.ts.
           */
          captureTrace: true,
          /**
           * Each turn written as it happens, so a running leaf can be watched.
           *
           * Two things this buys beyond the live view. A leaf whose activity is killed mid-run
           * keeps what it had already done — the end-of-run write alone lost the trace for exactly
           * the crashes worth reading. And the board can show progress without the worker needing
           * a socket: it runs in a different process from the one holding the connections, so the
           * database is the only channel both ends already share.
           *
           * Never fatal. A step that cannot be recorded must not end the work it is recording.
           */
          onStep: (step) => {
            void db.appendLeafStep({
              id: leaf.id,
              ownerId: leaf.ownerId,
              branchId: leaf.branchId,
              step,
              totalSteps: step.step,
              tokensUsed: step.tokens,
              createdAt: new Date().toISOString(),
            }).catch((err) => {
              console.warn(`[ExecuteLeafActivity] leaf ${leaf.id}: could not record step ${step.step}: ${err?.message}`);
            });
          },
          // Everything the persona decides — toolset, budget, pacing, withdrawal — plus the parts
          // only this caller knows. One assembly, shared with the Lab and the landing resolver,
          // because three hand-maintained copies of it drifted in three different directions.
          ...agentRunOptions(persona, {
            taskContext,
            overrides: adopted,
            ...(memoryContext ? { memoryContext } : {}),
            ...(wantsWeb(persona) ? { web: await buildWebTools(db, leaf.ownerId) } : {}),
            sandbox: {
              exec: (command) => workspaces.exec(leaf.id, command),
              readFile: (path) => workspaces.readFile(leaf.id, path),
              writeFile: (path, content) => workspaces.writeFile(leaf.id, path, content),
            },
          }),
        });

        // Tokens are recorded on the leaf whether or not the work succeeded — a failed attempt
        // costs exactly as much as a successful one and must count against the root's budget, or
        // a leaf that fails repeatedly becomes the cheapest thing on the board.
        const spent = { ...(leaf.usage ?? {}), tokens: (leaf.usage?.tokens ?? 0) + run.tokensUsed };

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
            steps: fitted.steps,
            ...(fitted.trimmed ? { trimmed: true } : {}),
            totalSteps: run.trace.length,
            tokensUsed: run.tokensUsed,
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
        const verifyCommand = wantsRepo ? (leaf.verifyCommand?.trim() || defaultVerifyCommand(persona?.scope?.language as WorkspaceLanguage)) : '';
        if (outputPath) {
          const verdict = assessFindings(findings, outputPath, persona?.scope?.requireSources !== false);
          verify = { outcome: verdict.outcome, output: verdict.reason };
        } else if (verifyCommand) {
          verify = await workspaces
            .exec(leaf.id, buildVerifyScript(verifyCommand, persona?.scope?.language as WorkspaceLanguage), 300_000)
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
        const artifacts = wantsRepo && leaf.expects?.length
          ? await workspaces
              .exec(leaf.id, buildArtifactCheckScript(leaf.expects, project?.defaultBranch || 'main'), 60_000)
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

        const combined = combineVerification(verify.outcome, artifacts.outcome);
        const settled = decideStatus(run.succeeded, combined);

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
            .exec(leaf.id, 'cd /work/repo 2>/dev/null && git ls-files | head -60', 60_000)
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
            const { save, remove } = supersede(await db.getMemories(leaf.ownerId), learned);
            // Removed first: the replacement carries the same title, and leaving both in place for
            // even a moment is how a prompt ends up with two contradictory file listings.
            for (const id of remove) await db.deleteMemory(id).catch(() => undefined);
            for (const item of save) await db.saveMemory(item);
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
          const state = checkout
            ? await workspaces.exec(leaf.id, buildRepoStateScript(), 60_000)
                .then((r) => summariseRepoState(r.stdout))
                .catch(() => '')
            : '';
          if (await stillExists()) await db.saveLeaf({
            ...leaf,
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
        if (outputBranch && combined === 'passed') {
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
        if (await stillExists()) await db.saveLeaf({
          ...leaf, usage: spent, status: 'succeeded', column: 'review',
          ...(run.summary ? { summary: run.summary.slice(0, 8000) } : {}),
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
      // Written BEFORE rethrowing, so Temporal's retry re-reads a database this attempt changed.
      const attempts: LeafAttempt[] = [
        ...priorFailures,
        {
          // Read from the activity context, not passed in: an argument would be baked into
          // workflow history at the first call and stay 1 forever, mislabelling every retry.
          // Temporal counts attempts from 1; LeafAttempt counts from 0.
          attempt: Math.max(0, attemptNumber - 1),
          error: String(err?.message ?? err).slice(0, 2000),
          failedAt: new Date().toISOString(),
        },
      ];
      const latest = (await db.getLeaves()).find((c: Leaf) => c.id === args.leafId);
      if (latest && await stillExists()) {
        await db.saveLeaf({ ...latest, attempts, status: 'failed', updatedAt: new Date().toISOString() });
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
      throw err;
    }
  } finally {
    await db.close();
  }
}
