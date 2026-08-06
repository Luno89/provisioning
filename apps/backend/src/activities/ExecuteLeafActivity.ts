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
import { effectiveOverrides } from '../lib/harness-profile.js';
import { imageForLanguage } from '../lib/workspace-spec.js';
import { GiteaService } from '../services/GiteaService.js';
import { InfrastructureService } from '../services/InfrastructureService.js';
import { ProjectRepoService } from '../services/ProjectRepoService.js';

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
    const leaf = (await db.getLeaves()).find((c: Leaf) => c.id === args.leafId);
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
      const adopted = effectiveOverrides(await db.getHarnessProfile(leaf.ownerId));
      const chosen = typeof adopted.model === 'string' ? adopted.model : undefined;
      const { provider, baseUrl, apiKey } = await models.resolveBaseUrl(leaf.ownerId, chosen);

      /**
       * A leaf attached to a project gets that repository cloned in, and pushes a branch back.
       *
       * The credential is minted per attempt and revoked on teardown, and egress is opened to the
       * Gitea namespace ONLY — so the token the sandbox holds has both a narrow scope (push to
       * this user's repos, nothing else) and nowhere to be exfiltrated to.
       */
      const project = leaf.projectId
        ? (await db.getProjects()).find((p) => p.id === leaf.projectId && p.ownerId === leaf.ownerId)
        : undefined;

      let repos: ProjectRepoService | undefined;
      let checkout: { cloneUrl: string; tokenName: string; username: string } | undefined;
      let gitea0 = '';
      if (project) {
        const gitea = new GiteaService(
          new InfrastructureService(),
          process.env.JWT_SECRET ?? '',
          process.env.MANAGEMENT_KUBECONFIG ?? '/tmp/kubeconfig-provisioning-lunorica',
        );
        repos = new ProjectRepoService(db, gitea, process.env.JWT_SECRET ?? '');
        gitea0 = gitea.internalBaseUrl;
        checkout = await repos.checkoutCredential(leaf.ownerId, project);
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
          const branchName = `koala/${leaf.id.slice(0, 8)}`;
          const cloned = await workspaces.exec(
            leaf.id,
            [
              'set -e',
              'git clone "$0" /work/repo',
              'cd /work/repo',
              'git checkout -b "$1"',
              'git config user.email koala@local',
              'git config user.name Koala',
              // Strip the credential out of .git/config and hand it to the store helper instead.
              'git remote set-url origin "$2"',
              'git config credential.helper store',
              'printf "%s\\n" "$0" > "$HOME/.git-credentials"',
              'chmod 600 "$HOME/.git-credentials"',
            ].join('\n'),
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

        if (!run.succeeded) {
          // Thrown so the failure lands in the catch below, which is the ONE place that records an
          // attempt. A second recording path is how histories end up inconsistent.
          await db.saveLeaf({ ...leaf, usage: spent, updatedAt: new Date().toISOString() });
          throw new Error(run.summary);
        }

        const now = new Date().toISOString();
        await db.saveLeaf({ ...leaf, usage: spent, status: 'succeeded', column: 'review', updatedAt: now });
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
