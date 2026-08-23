/**
 * Runs the request's acceptance check against the assembled default branch, and tells the
 * conversation what happened either way.
 *
 * ── WHY AT THE REQUEST LEVEL ──
 * Every check before this one is per-leaf, and they were all passing while the delivered program
 * printed its own name and exited. Nothing was wrong with them: each verified what its leaf was
 * for. The gap was that no leaf's job was the whole, so the assembled result was never run by
 * anything except a human who thought to clone the repository and try it.
 *
 * This runs the command a user would type, against the branch they would actually get.
 *
 * ── AND WHY IT REPORTS RATHER THAN FAILS ──
 * It does not mark leaves failed. They did their jobs; the composition is what did not work, and
 * blaming the last leaf to finish would be both wrong and unhelpful. The verdict goes into the
 * branch so the person reads it in the conversation and the next planning turn already knows —
 * which is the whole difference between the harness noticing and a person having to.
 */
import { createDatabase } from '../lib/db-interface.js';
import { countWorkspace } from '../lib/leaf-usage.js';
import { requestFinished, type Branch, type Leaf } from '../lib/leaves.js';
import { WorkspaceService } from '../services/WorkspaceService.js';
import { GiteaService } from '../services/GiteaService.js';
import { InfrastructureService } from '../services/InfrastructureService.js';
import { ProjectRepoService } from '../services/ProjectRepoService.js';
import { imageForLanguage } from '../lib/workspace-spec.js';
import { buildAcceptanceScript, parseAcceptance, usableAcceptancePlan } from '../lib/acceptance.js';
import { buildAcceptanceNotice, withNotice } from '../lib/branch-notice.js';
import type { ProjectMetadata } from '../lib/types.js';

export interface AcceptRequestArgs {
  /** Any leaf of the request; the branch is derived from it. */
  leafId: string;
}

export interface AcceptRequestResult {
  outcome: 'passed' | 'failed' | 'skipped' | 'unknown';
}

export async function AcceptRequestActivity(args: AcceptRequestArgs): Promise<AcceptRequestResult> {
  const db = createDatabase();
  await db.init();
  const workspaceId = `accept-${args.leafId}`;
  const workspaces = new WorkspaceService(process.env.WORKSPACE_KUBECONFIG);
  let repos: ProjectRepoService | undefined;
  let checkout: { cloneUrl: string; tokenName: string; username: string } | undefined;
  let ownerId = '';

  try {
    const all = await db.getLeaves();
    const self = all.find((l: Leaf) => l.id === args.leafId);
    if (!self) { console.log('[AcceptRequest] skip: no such leaf'); return { outcome: 'skipped' }; }
    ownerId = self.ownerId;

    const branch = (await db.getBranches()).find((b: Branch) => b.id === self.branchId);
    const plan = usableAcceptancePlan(branch?.acceptance);
    // No acceptance declared. Reported as skipped rather than passed — "nobody checked" and "it
    // works" are the distinction this whole file exists to preserve.
    if (!branch || plan.length === 0) { console.log(`[AcceptRequest] skip: branch=${Boolean(branch)} checks=${plan.length}`); return { outcome: 'skipped' }; }

    const leaves = all.filter((l: Leaf) => l.branchId === self.branchId);
    if (!requestFinished(leaves)) { console.log('[AcceptRequest] skip: request still working'); return { outcome: 'skipped' }; }
    // Already reported for this request — the sweep runs on every leaf's terminal exit, and one
    // acceptance verdict per request is the point.
    if (branch.acceptanceRunAt) { console.log('[AcceptRequest] skip: already run'); return { outcome: 'skipped' }; }

    const project = (await db.getProjects())
      .find((p: ProjectMetadata) => p.id === leaves.find((l) => l.projectId)?.projectId);
    if (!project?.giteaOwner || !project.giteaRepo) { console.log('[AcceptRequest] skip: no project repo'); return { outcome: 'skipped' }; }

    const gitea = new GiteaService(
      new InfrastructureService(),
      process.env.JWT_SECRET ?? '',
      process.env.MANAGEMENT_KUBECONFIG ?? '/tmp/kubeconfig-provisioning-lunorica',
    );
    repos = new ProjectRepoService(db, gitea, process.env.JWT_SECRET ?? '');
    checkout = await repos.checkoutCredential(ownerId, project);

    await workspaces.destroy(workspaceId).catch(() => undefined);
    await workspaces.create({
      leafId: workspaceId,
      ownerId,
      image: imageForLanguage(undefined),
      /**
       * Gitea to clone with, and the open internet to run in.
       *
       * Omitting this does NOT mean unrestricted — the workspace policy is default-deny with DNS
       * excepted, so an empty egress list blocks everything including the clone. That is exactly
       * what happened the first time: the activity returned `unknown` because `git clone` could not
       * reach Gitea at all.
       *
       * The wide rule is the point rather than an oversight. An acceptance check runs the
       * deliverable, and the deliverable is usually the thing that talks to the outside world — the
       * CLI that motivated all of this makes two live HTTP calls. A check that cannot reach the
       * network would report every such program broken.
       */
      egress: [{ namespace: 'gitea', ports: [3000] }, { cidr: '0.0.0.0/0' }],
    });
    // One of the three counted sites — see lib/leaf-usage.ts. Attributed to the leaf the request
    // was reached through, not to `workspaceId` (`accept-<leafId>`), which matches no leaf record.
    await countWorkspace(db, args.leafId);

    const cloned = await workspaces.exec(workspaceId, [
      'set -e',
      `git clone --branch "$1" --depth 20 "$0" /work/repo`,
      /**
       * The push credential is scrubbed before anything runs.
       *
       * Unlike a leaf's sandbox, this pod can reach the whole internet — it has to, to run the
       * deliverable. Leaving a token that can write to this user's repositories inside a pod that
       * is about to execute agent-written code with open egress is a combination worth not having.
       * The clone is the only thing here that needs it.
       */
      'cd /work/repo && git remote set-url origin "" >/dev/null 2>&1 || true',
      'rm -f "$HOME/.git-credentials"',
    ].join('\n'), 180_000, [checkout.cloneUrl, project.defaultBranch || 'main']);
    if (cloned.exitCode !== 0) {
      // Logged, not silent: this returned `unknown` with no explanation once already, and an
      // unexplained `unknown` is indistinguishable from the check never having run.
      console.warn(`[AcceptRequest] could not clone for the acceptance check: ${cloned.stderr.slice(0, 300)}`);
      return { outcome: 'unknown' };
    }

    /**
     * In order, stopping at the first failure.
     *
     * Continuing past one would report a pile of consequences: a project whose install failed
     * fails its tests and its run too, and three red checks say no more than the first. Stopping
     * also means the reported failure is the one worth acting on.
     */
    let failed: { name: string; output: string } | undefined;
    for (const check of plan) {
      const result = parseAcceptance(
        (await workspaces.exec(workspaceId, buildAcceptanceScript(check.command), 300_000)).stdout,
      );
      if (result.outcome === 'unknown') {
        console.warn(`[AcceptRequest] "${check.name}" produced no verdict: ${result.output.slice(0, 200)}`);
        return { outcome: 'unknown' };
      }
      if (result.outcome === 'failed') { failed = { name: check.name, output: result.output }; break; }
    }
    const result = { outcome: failed ? 'failed' as const : 'passed' as const };

    // Re-read: the branch has been sitting in memory while a workspace booted and a program ran,
    // and a full-object save from stale state would drop whatever was said meanwhile.
    const latest = (await db.getBranches()).find((b: Branch) => b.id === self.branchId);
    if (latest) {
      await db.saveBranch({
        ...withNotice(latest, buildAcceptanceNotice(plan, failed)),
        acceptanceRunAt: new Date().toISOString(),
        // Stored as data, not only as prose in the notice. The notice tells a reader what happened;
        // this is what lets the branch itself say whether the request delivered.
        acceptanceOutcome: result.outcome,
        ...(failed ? { acceptanceFailedCheck: failed.name } : {}),
      });
    }
    console.log(`[AcceptRequest] ${plan.length} check(s) ${result.outcome}${failed ? ` at "${failed.name}"` : ''} for request ${self.branchId.slice(0, 8)}`);
    return { outcome: result.outcome };
  } catch (err) {
    // Never fatal: the work is landed either way, and failing a leaf's workflow over the acceptance
    // harness would turn "we could not check" into "the work broke".
    console.warn(`[AcceptRequest] could not run the acceptance check: ${(err as Error).message}`);
    return { outcome: 'unknown' };
  } finally {
    await workspaces.destroy(workspaceId).catch(() => undefined);
    if (repos && checkout) await repos.revokeCheckout(ownerId, checkout.tokenName).catch(() => undefined);
    await db.close();
  }
}
