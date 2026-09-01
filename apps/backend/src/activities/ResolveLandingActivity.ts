import { createDatabase } from '../lib/db-interface.js';
import { countWorkspace } from '../lib/leaf-usage.js';
import { unlandedWork, type Leaf } from '../lib/leaves.js';
import { WorkspaceService } from '../services/WorkspaceService.js';
import { GiteaService } from '../services/GiteaService.js';
import { InfrastructureService } from '../services/InfrastructureService.js';
import { ProjectRepoService } from '../services/ProjectRepoService.js';
import { createModelService } from '../lib/model-wiring.js';
import { runAgentLoop } from '../lib/agent-loop.js';
import { agentRunOptions } from '../lib/agent-run.js';
import { flattenPersona, personaWorkspace } from '../lib/persona-scope.js';
import { ToolService } from '../services/ToolService.js';
import type { WorkspaceLanguage } from '../lib/workspace-spec.js';
import { MERGER_PERSONA } from '../lib/well-known-personas.js';
import { resolvePrompt } from '../lib/personas.js';
import {
  buildLandingSetupScript, buildMergeOneScript, buildMergeCompleteScript, parseLandingMerge, buildMergeTask,
} from '../lib/merge-agent.js';
import { buildVerifyScript, parseVerifyResult, defaultVerifyCommand } from '../lib/leaf-verify.js';
import type { ProjectMetadata } from '../lib/types.js';
import { withBuiltIns } from '../lib/ownership.js';
import { WorkspaceImageService } from '../services/WorkspaceImageService.js';
import { requireBudget } from '../lib/pack-defaults.js';
import { ranAs } from '../lib/run-provenance.js';

export interface ResolveLandingArgs {
  leafId: string;
}

export interface ResolveLandingResult {
  outcome: 'landed' | 'nothing-to-do' | 'unresolved';
  landed: string[];
}

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

    const packs = withBuiltIns(await db.getPersonaPacks(), ownerId, (p) => p.slug);
    const pack = packs.find((p) => p.name === MERGER_PERSONA) ?? null;
    const ownPersonas = withBuiltIns(await db.getPersonas(), ownerId, (p) => p.name);
    const assigned = pack ? ownPersonas.find((p) => p.id === pack.personaId) : undefined;
    const persona = assigned ? flattenPersona(assigned, ownPersonas) : null;
    if (!pack) console.warn(`[ResolveLanding] no "${MERGER_PERSONA}" pack — running with harness defaults`);
    await workspaces.destroy(workspaceId).catch(() => undefined);
    await workspaces.create(personaWorkspace(
      await new WorkspaceImageService(db).list(ownerId),
      pack, { leafId: workspaceId, ownerId }, { language: project.language },
    ));
    await countWorkspace(db, args.leafId);

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
    const profile = await db.getHarnessProfile(ownerId);
    const language = (project.language ?? pack?.workspace?.language) as WorkspaceLanguage | undefined;
    const systemPrompt = resolvePrompt(persona);
    // The engine is the pack's; nothing layered can name one any more.
    const chosen = undefined;
    const { provider, baseUrl, apiKey, source: endpointSource } = await models.resolveBaseUrl(ownerId, chosen, pack?.model?.endpointId);

    let merged = true;
    for (const branch of branches) {
      const attempt = await workspaces.exec(workspaceId, buildMergeOneScript(branch), 180_000);
      let state = parseLandingMerge(attempt.stdout);
      console.log(`[ResolveLanding] merging ${branch}: ${state.outcome}${state.files.length ? ` (${state.files.join(', ')})` : ''}`);

      if (state.outcome === 'clean' || state.outcome === 'skipped') continue;
      if (state.outcome !== 'conflict') { merged = false; break; }

      let settled = false;
      for (let round = 0; round < MAX_ROUNDS && !settled; round++) {
        const run = await runAgentLoop({
          catalogue: await new ToolService(db).schemas(ownerId),
          images: await new WorkspaceImageService(db).list(ownerId),
          ...(pack?.sampling ? { sampling: pack.sampling } : {}),
          baseUrl,
          ...(apiKey ? { apiKey } : {}),
          model: provider.model,
          ...(provider.kind ? { kind: provider.kind } : {}),
          ...(language ? { language } : {}),
          ...agentRunOptions(pack?.budget ?? await requireBudget(db), pack, {
            ...(() => {
              const provenance = ranAs(pack, { id: provider.id, source: endpointSource });
              return provenance ? { ranAs: provenance } : {};
            })(),
            taskContext: buildMergeTask(branch, state.files),
            sandbox: {
              exec: (command) => workspaces.exec(workspaceId, command),
              readFile: (path) => workspaces.readFile(workspaceId, path),
              writeFile: (path, content) => workspaces.writeFile(workspaceId, path, content),
            },
          }),
        });

        const check = await workspaces.exec(workspaceId, buildMergeCompleteScript(), 60_000);
        state = parseLandingMerge(check.stdout);
        settled = state.outcome === 'clean';
        console.log(`[ResolveLanding] ${branch} round ${round + 1}: agent succeeded=${run.succeeded}, tree is ${state.outcome}`);
      }

      if (!settled) { merged = false; break; }
    }

    if (!merged) return { outcome: 'unresolved', landed: [] };

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
      const latest = (await db.getLeaves()).find((l: Leaf) => l.id === leaf.id);
      if (latest) {
        await db.saveLeaf({ ...latest, merged: true, updatedAt: new Date().toISOString() });
        landed.push(leaf.id);
      }
    }
    return { outcome: 'landed', landed };
  } catch (err) {
    console.warn(`[ResolveLanding] could not land automatically: ${(err as Error).message}`);
    return { outcome: 'unresolved', landed: [] };
  } finally {
    await workspaces.destroy(workspaceId).catch(() => undefined);
    if (repos && checkout) await repos.revokeCheckout(ownerId, checkout.tokenName).catch(() => undefined);
    await db.close();
  }
}
