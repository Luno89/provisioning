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
    if (!branch || plan.length === 0) { console.log(`[AcceptRequest] skip: branch=${Boolean(branch)} checks=${plan.length}`); return { outcome: 'skipped' }; }

    const leaves = all.filter((l: Leaf) => l.branchId === self.branchId);
    if (!requestFinished(leaves)) { console.log('[AcceptRequest] skip: request still working'); return { outcome: 'skipped' }; }
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
      egress: [{ namespace: 'gitea', ports: [3000] }, { cidr: '0.0.0.0/0' }],
    });
    await countWorkspace(db, args.leafId);

    const cloned = await workspaces.exec(workspaceId, [
      'set -e',
      `git clone --branch "$1" --depth 20 "$0" /work/repo`,
      'cd /work/repo && git remote set-url origin "" >/dev/null 2>&1 || true',
      'rm -f "$HOME/.git-credentials"',
    ].join('\n'), 180_000, [checkout.cloneUrl, project.defaultBranch || 'main']);
    if (cloned.exitCode !== 0) {
      console.warn(`[AcceptRequest] could not clone for the acceptance check: ${cloned.stderr.slice(0, 300)}`);
      return { outcome: 'unknown' };
    }

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

    const latest = (await db.getBranches()).find((b: Branch) => b.id === self.branchId);
    if (latest) {
      await db.saveBranch({
        ...withNotice(latest, buildAcceptanceNotice(plan, failed)),
        acceptanceRunAt: new Date().toISOString(),
        acceptanceOutcome: result.outcome,
        ...(failed ? { acceptanceFailedCheck: failed.name } : {}),
      });
    }
    console.log(`[AcceptRequest] ${plan.length} check(s) ${result.outcome}${failed ? ` at "${failed.name}"` : ''} for request ${self.branchId.slice(0, 8)}`);
    return { outcome: result.outcome };
  } catch (err) {
    console.warn(`[AcceptRequest] could not run the acceptance check: ${(err as Error).message}`);
    return { outcome: 'unknown' };
  } finally {
    await workspaces.destroy(workspaceId).catch(() => undefined);
    if (repos && checkout) await repos.revokeCheckout(ownerId, checkout.tokenName).catch(() => undefined);
    await db.close();
  }
}
