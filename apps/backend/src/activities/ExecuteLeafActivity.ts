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
import { failureContext, type Leaf, type LeafAttempt } from '../lib/leaves.js';
import { WorkspaceService } from '../services/WorkspaceService.js';
import { createModelService } from '../lib/model-wiring.js';
import { runAgentLoop } from '../lib/agent-loop.js';
import { resolveConfig } from '../lib/personas.js';
import { imageForLanguage } from '../lib/workspace-spec.js';
import { GiteaService } from '../services/GiteaService.js';
import { InfrastructureService } from '../services/InfrastructureService.js';
import { ProjectRepoService } from '../services/ProjectRepoService.js';
import { v4 as uuidv4 } from 'uuid';
import type { ProjectMetadata } from '../lib/types.js';
import { resolveLeafProject } from '../lib/leaf-project.js';
import {
  branchNameFor, baseBranchesFor, buildCheckoutScript, buildPushScript, parsePushedBranch,
  buildRepoStateScript, summariseRepoState,
} from '../lib/leaf-checkout.js';
import {
  defaultVerifyCommand, buildVerifyScript, parseVerifyResult, decideStatus, type VerifyResult,
} from '../lib/leaf-verify.js';

export interface ExecuteLeafArgs {
  leafId: string;
}

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
      const persona = leaf.personaId
        ? (await db.getPersonas()).find((p) => p.id === leaf.personaId && p.ownerId === leaf.ownerId) ?? null
        : null;
      const resolved = resolveConfig(await db.getHarnessProfile(leaf.ownerId), persona);
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
      const gitea = new GiteaService(
        new InfrastructureService(),
        process.env.JWT_SECRET ?? '',
        process.env.MANAGEMENT_KUBECONFIG ?? '/tmp/kubeconfig-provisioning-lunorica',
      );
      let project: ProjectMetadata | undefined;
      try {
        const projectRepos = new ProjectRepoService(db, gitea, process.env.JWT_SECRET ?? '');
        project = await resolveLeafProject({
          db,
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
      await workspaces.create({
        leafId: leaf.id,
        ownerId: leaf.ownerId,
        image: imageForLanguage(leaf.language),
        // The pod port, and a namespace selector rather than an address — a NodePort CIDR rule
        // silently fails closed because kube-proxy DNATs before policy evaluation.
        ...(checkout ? { egress: [{ namespace: 'gitea', ports: [3000] }] } : {}),
      });

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

        const run = await runAgentLoop({
          baseUrl,
          apiKey,
          model: provider.model,
          ...(provider.kind ? { kind: provider.kind } : {}),
          language: leaf.language,
          taskContext,
          // The point of promoting a configuration: a setting that won on the bench takes effect on
          // the work that matters, not only on the next experiment. Without this the Lab measures a
          // harness that real leaves never run.
          overrides: adopted,
          sandbox: {
            exec: (command) => workspaces.exec(leaf.id, command),
            readFile: (path) => workspaces.readFile(leaf.id, path),
            writeFile: (path, content) => workspaces.writeFile(leaf.id, path, content),
          },
        });

        // Tokens are recorded on the leaf whether or not the work succeeded — a failed attempt
        // costs exactly as much as a successful one and must count against the root's budget, or
        // a leaf that fails repeatedly becomes the cheapest thing on the board.
        const spent = { ...(leaf.usage ?? {}), tokens: (leaf.usage?.tokens ?? 0) + run.tokensUsed };

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
        let verify: VerifyResult = { outcome: 'unverified', output: '' };
        const verifyCommand = leaf.verifyCommand?.trim() || defaultVerifyCommand(leaf.language);
        if (verifyCommand) {
          verify = await workspaces
            .exec(leaf.id, buildVerifyScript(verifyCommand, leaf.language), 300_000)
            .then((r) => parseVerifyResult(r.stdout))
            .catch(() => ({ outcome: 'unverified' as const, output: '' }));
        }
        const settled = decideStatus(run.succeeded, verify.outcome);

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
          const partial = await pushBack();
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
          await db.saveLeaf({
            ...leaf,
            usage: spent,
            ...(partial ? { outputBranch: partial } : {}),
            ...(project ? { projectId: project.id } : {}),
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
            ...(partial ? [`Work so far is committed on ${partial} and will be waiting at /work/repo next attempt.`] : []),
            ...(state ? [`State of the repository when this attempt ended:\n${state}`] : []),
          ].join('\n\n'));
        }

        const outputBranch = await pushBack();

        const now = new Date().toISOString();
        // The summary is persisted, not just returned: a caller that reads the workflow result is
        // not the same as a board someone can look at.
        await db.saveLeaf({
          ...leaf, usage: spent, status: 'succeeded', column: 'review',
          ...(run.summary ? { summary: run.summary.slice(0, 8000) } : {}),
          /**
           * Whether anything actually checked this, so the board can say "verified" or "claimed"
           * rather than showing the same green tick for both. An unverified success is still a
           * success — most leaves are not test-shaped — it is just not evidence.
           */
          verified: verify.outcome === 'passed',
          // Recorded so a later leaf can find the work, and so the board can link to it.
          ...(project ? { projectId: project.id } : {}),
          ...(outputBranch ? { outputBranch } : {}),
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
      if (latest) await db.saveLeaf({ ...latest, attempts, status: 'failed', updatedAt: new Date().toISOString() });
      throw err;
    }
  } finally {
    await db.close();
  }
}
