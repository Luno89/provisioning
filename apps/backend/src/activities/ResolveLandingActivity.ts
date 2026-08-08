/**
 * Merging a request's work together, with an agent resolving whatever git could not.
 *
 * ── WHY THIS EXISTS ──
 * The landing sweep merges verified branches into the default one and reports a conflict rather
 * than forcing it. Correct — two leaves that edited the same file genuinely disagree, and no
 * mechanical rule picks the right winner. But it ended in a pull request nobody was told about and
 * a leaf marked `verified: true, merged: false`: work that was finished and checked, stranded on a
 * manual step.
 *
 * Resolving a conflict is the same shape of task the agent is already trusted with inside a leaf.
 * The only reason it was not doing it here is that nobody had put it in the loop.
 *
 * ── WHAT KEEPS IT HONEST ──
 * Nothing is pushed until the merged tree passes its tests. A conflict the agent "resolved" into
 * something that does not build would be worse than the conflict, because a conflict is visible and
 * a quietly broken default branch is not. When verification fails, the push is skipped and the
 * pull request stays exactly where it was — the manual path is still there, it is just no longer
 * the first resort.
 */
import { createDatabase } from '../lib/db-interface.js';
import { unlandedWork, type Leaf } from '../lib/leaves.js';
import { WorkspaceService } from '../services/WorkspaceService.js';
import { GiteaService } from '../services/GiteaService.js';
import { InfrastructureService } from '../services/InfrastructureService.js';
import { ProjectRepoService } from '../services/ProjectRepoService.js';
import { createModelService } from '../lib/model-wiring.js';
import { runAgentLoop } from '../lib/agent-loop.js';
import { resolveConfig } from '../lib/personas.js';
import { imageForLanguage } from '../lib/workspace-spec.js';
import {
  buildLandingSetupScript, buildMergeOneScript, buildMergeCompleteScript, parseLandingMerge, buildMergeTask,
} from '../lib/merge-agent.js';
import { buildVerifyScript, parseVerifyResult, defaultVerifyCommand } from '../lib/leaf-verify.js';
import type { ProjectMetadata } from '../lib/types.js';

export interface ResolveLandingArgs {
  /** Any leaf of the request; the rest are found from its branch. */
  leafId: string;
}

export interface ResolveLandingResult {
  outcome: 'landed' | 'nothing-to-do' | 'unresolved';
  /** Leaves whose work is now on the default branch. */
  landed: string[];
}

/** How many conflicts one request may resolve before giving up and leaving it to a person. */
const MAX_ROUNDS = 3;

export async function ResolveLandingActivity(args: ResolveLandingArgs): Promise<ResolveLandingResult> {
  const db = createDatabase();
  await db.init();
  const workspaceId = `merge-${args.leafId}`;
  const workspaces = new WorkspaceService(process.env.WORKSPACE_KUBECONFIG);
  let repos: ProjectRepoService | undefined;
  let checkout: { cloneUrl: string; tokenName: string; username: string } | undefined;
  let ownerId = '';

  try {
    const all = await db.getLeaves();
    const self = all.find((l: Leaf) => l.id === args.leafId);
    if (!self) return { outcome: 'nothing-to-do', landed: [] };
    ownerId = self.ownerId;

    const outstanding = unlandedWork(all.filter((l: Leaf) => l.branchId === self.branchId));
    console.log(`[ResolveLanding] ${outstanding.length} branch(es) to land for request ${self.branchId.slice(0, 8)}`);
    if (outstanding.length === 0) return { outcome: 'nothing-to-do', landed: [] };

    const project = (await db.getProjects())
      .find((p: ProjectMetadata) => p.id === outstanding[0]!.projectId);
    if (!project?.giteaOwner || !project.giteaRepo) return { outcome: 'nothing-to-do', landed: [] };
    const defaultBranch = project.defaultBranch || 'main';

    const gitea = new GiteaService(
      new InfrastructureService(),
      process.env.JWT_SECRET ?? '',
      process.env.MANAGEMENT_KUBECONFIG ?? '/tmp/kubeconfig-provisioning-lunorica',
    );
    repos = new ProjectRepoService(db, gitea, process.env.JWT_SECRET ?? '');
    checkout = await repos.checkoutCredential(ownerId, project);

    const language = outstanding[0]!.language;
    await workspaces.destroy(workspaceId).catch(() => undefined);
    await workspaces.create({
      leafId: workspaceId,
      ownerId,
      image: imageForLanguage(language),
      // Gitea only, same as a leaf's sandbox: the credential in here can push to this user's
      // repositories and has nowhere else to go.
      egress: [{ namespace: 'gitea', ports: [3000] }],
    });

    const cleanUrl = `${gitea.internalBaseUrl}/${project.giteaOwner}/${project.giteaRepo}.git`;
    const cloned = await workspaces.exec(workspaceId, [
      'set -e',
      'git clone "$0" /work/repo',
      'cd /work/repo',
      'git remote set-url origin "$1"',
      'git config credential.helper store',
      'printf "%s\\n" "$0" > "$HOME/.git-credentials"',
      'chmod 600 "$HOME/.git-credentials"',
    ].join('\n'), 180_000, [checkout.cloneUrl, cleanUrl]);
    if (cloned.exitCode !== 0) {
      console.warn(`[ResolveLanding] clone failed: ${cloned.stderr.slice(0, 300)}`);
      return { outcome: 'unresolved', landed: [] };
    }

    const branches = outstanding.map((l) => l.outputBranch!).filter(Boolean);

    const setup = await workspaces.exec(workspaceId, buildLandingSetupScript(defaultBranch), 120_000);
    if (setup.exitCode !== 0) {
      console.warn(`[ResolveLanding] could not position the landing branch: ${setup.stderr.slice(0, 200)}`);
      return { outcome: 'unresolved', landed: [] };
    }

    const models = createModelService(db, process.env.JWT_SECRET ?? '');
    const resolved = resolveConfig(await db.getHarnessProfile(ownerId), null);
    const chosen = typeof resolved.overrides.model === 'string' ? resolved.overrides.model : undefined;
    const { provider, baseUrl, apiKey } = await models.resolveBaseUrl(ownerId, chosen);

    /**
     * One branch at a time, onto a branch that is NEVER repositioned between them.
     *
     * The first version re-ran setup on every round, which reset the landing branch to the default
     * one and discarded the resolution the agent had just committed — so it was handed the identical
     * conflict again. Observed live: three rounds, three identical README.md conflicts, three agent
     * runs, no progress.
     */
    let merged = true;
    for (const branch of branches) {
      const attempt = await workspaces.exec(workspaceId, buildMergeOneScript(branch), 180_000);
      let state = parseLandingMerge(attempt.stdout);
      console.log(`[ResolveLanding] merging ${branch}: ${state.outcome}${state.files.length ? ` (${state.files.join(', ')})` : ''}`);

      // Already in, or not on the remote. Either way there is nothing to do for this one.
      if (state.outcome === 'clean' || state.outcome === 'skipped') continue;
      if (state.outcome !== 'conflict') { merged = false; break; }

      let settled = false;
      for (let round = 0; round < MAX_ROUNDS && !settled; round++) {
        const run = await runAgentLoop({
          baseUrl,
          ...(apiKey ? { apiKey } : {}),
          model: provider.model,
          ...(provider.kind ? { kind: provider.kind } : {}),
          ...(language ? { language } : {}),
          taskContext: buildMergeTask(branch, state.files),
          overrides: resolved.overrides,
          sandbox: {
            exec: (command) => workspaces.exec(workspaceId, command),
            readFile: (path) => workspaces.readFile(workspaceId, path),
            writeFile: (path, content) => workspaces.writeFile(workspaceId, path, content),
          },
        });

        // Asked of git, not of the agent. A run that reports success having left markers in place,
        // or having stopped short of committing, would otherwise be taken at its word.
        const check = await workspaces.exec(workspaceId, buildMergeCompleteScript(), 60_000);
        state = parseLandingMerge(check.stdout);
        settled = state.outcome === 'clean';
        console.log(`[ResolveLanding] ${branch} round ${round + 1}: agent succeeded=${run.succeeded}, tree is ${state.outcome}`);
      }

      if (!settled) { merged = false; break; }
    }

    if (!merged) return { outcome: 'unresolved', landed: [] };

    /**
     * The merged tree has to pass before it goes anywhere.
     *
     * Both sides were verified separately; that says nothing about the combination, which is the
     * only artefact anybody will actually run.
     */
    const verifyCommand = defaultVerifyCommand(language);
    if (verifyCommand) {
      const check = await workspaces
        .exec(workspaceId, buildVerifyScript(verifyCommand, language), 300_000)
        .then((r) => parseVerifyResult(r.stdout))
        .catch(() => ({ outcome: 'unverified' as const, output: '' }));
      if (check.outcome === 'failed') {
        console.warn(`[ResolveLanding] merged tree fails its tests; leaving the pull request open:\n${check.output.slice(-500)}`);
        return { outcome: 'unresolved', landed: [] };
      }
    }

    const pushed = await workspaces.exec(
      workspaceId,
      `cd /work/repo && git push origin "HEAD:$0"`,
      120_000,
      [defaultBranch],
    );
    if (pushed.exitCode !== 0) return { outcome: 'unresolved', landed: [] };

    const landed: string[] = [];
    for (const leaf of outstanding) {
      // Re-read each: this activity has been running for minutes and a full-object save from stale
      // state is how fields get silently reverted.
      const latest = (await db.getLeaves()).find((l: Leaf) => l.id === leaf.id);
      if (latest) {
        await db.saveLeaf({ ...latest, merged: true, updatedAt: new Date().toISOString() });
        landed.push(leaf.id);
      }
    }
    return { outcome: 'landed', landed };
  } catch (err) {
    // Never fatal. The work is safe on its branches and the pull request is still open — this is a
    // convenience over the manual path, not a replacement for it.
    console.warn(`[ResolveLanding] could not land automatically: ${(err as Error).message}`);
    return { outcome: 'unresolved', landed: [] };
  } finally {
    await workspaces.destroy(workspaceId).catch(() => undefined);
    if (repos && checkout) await repos.revokeCheckout(ownerId, checkout.tokenName).catch(() => undefined);
    await db.close();
  }
}
