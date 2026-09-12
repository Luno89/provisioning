import { Router, type Request } from 'express';
import crypto from 'crypto';
import { encryptValue } from '../lib/crypto.js';
import { asyncRoute } from '../middleware/async-route.js';
import { isWorkspaceLanguage } from '../lib/workspace-image-catalogue.js';
import { WorkspaceImageService } from '../services/WorkspaceImageService.js';
import { v4 as uuidv4 } from 'uuid';
import { ownsProject } from '../lib/ownership.js';
import { rollupProjectStatus, deploymentForProject } from '../lib/project-status.js';
import { webhookUrlFor } from '../lib/project-shipping.js';
import { validateLocalEgressRules } from '../lib/personas.js';

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

const claimedByAnotherProject = (
  projects: any[], deviceId: string, path: string | undefined, excludeProjectId?: string,
): boolean =>
  projects.some((p) => p.id !== excludeProjectId
    && p.executionTarget?.kind === 'local-device'
    && p.executionTarget.deviceId === deviceId
    && (p.executionTarget.path ?? '') === (path ?? ''));

export function projectsRouter(deps: Record<string, any>): Router {
  const {
    db, projectRepoService, appService, temporalBridge, getOwnedProject,
    giteaService, clusterService, infraService, jwtSecret,
  } = deps;
  const router = Router();

  router.get('/', async (req, res) => {
    const projects = await db.getProjects();
    const mine = projects.filter((p: any) => ownsProject(p, userOf(req)));
    const [runs, deployments] = await Promise.all([db.getPipelineRuns(), db.getDeployments()]);
    res.json(mine.map((p: any) => ({
      ...p,
      ...rollupProjectStatus(p, runs, deploymentForProject(p, deployments)),
    })));
  });

  router.get('/:id/runs', async (req, res) => {
    const project = await getOwnedProject(req.params.id, userOf(req));
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const runs = (await db.getPipelineRuns())
      .filter((r: any) => r.projectId === req.params.id)
      .sort((a: any, b: any) => b.startedAt.localeCompare(a.startedAt));

    const enriched = await Promise.all(runs.map(async (run: any) => {
      if (run.commitMessage || !run.commitSha) return run;
      try {
        const commit = await giteaService.getCommit(project.giteaOwner, project.giteaRepo, run.commitSha);
        if (!commit?.message) return run;
        const updated = await db.savePipelineRunInfo({ id: run.id, commitMessage: commit.message });
        return updated;
      } catch {
        return run;
      }
    }));

    res.json(enriched);
  });

  router.post('/', async (req, res) => {
    try {
      const {
        name, giteaOwner, giteaRepo, createRepo, targetClusterId, targetNamespace, autoDeployOnBuild, language,
        executionTargetDeviceId, executionTargetPath, executionApproval, executionTargetEgress,
      } = req.body;
      if (!name) return res.status(400).json({ error: 'name is required' });
      const wantsRepo = Boolean(giteaRepo);
      if (!wantsRepo && !executionTargetDeviceId) {
        return res.status(400).json({ error: 'giteaRepo is required unless the project runs on a registered local machine' });
      }

      const path = typeof executionTargetPath === 'string' && executionTargetPath.trim()
        ? executionTargetPath.trim()
        : undefined;

      let executionTarget: { kind: 'k8s' } | { kind: 'local-device'; deviceId: string; path?: string; egress?: any[] } | undefined;
      if (executionTargetDeviceId) {
        const owned = (await db.getLocalAgentDevices())
          .find((d: any) => d.id === executionTargetDeviceId && d.ownerId === userOf(req).id);
        if (!owned) return res.status(400).json({ error: 'Unknown local execution device' });

        if (claimedByAnotherProject(await db.getProjects(), executionTargetDeviceId, path)) {
          return res.status(409).json({ error: 'That machine (at that path) is already the execution target for another project.' });
        }

        const egressError = validateLocalEgressRules(executionTargetEgress);
        if (egressError) return res.status(400).json({ error: egressError });

        executionTarget = {
          kind: 'local-device',
          deviceId: owned.id,
          ...(path ? { path } : {}),
          ...(Array.isArray(executionTargetEgress) && executionTargetEgress.length
            ? { egress: executionTargetEgress }
            : {}),
        };
      }

      const id = uuidv4();
      let repoFields: Record<string, unknown> = {};

      if (wantsRepo) {
        let owner = giteaOwner || giteaService.adminUsername;

        if (createRepo) {
          const account = await projectRepoService.ensureAccountFor(userOf(req).id);
          owner = account.username;
          await giteaService.createRepoForUser(owner, giteaRepo, { description: `Provisioning project: ${name}` });
        } else {
          await giteaService.getRepo(owner, giteaRepo);
        }

        const webhookSecret = crypto.randomBytes(32).toString('hex');
        const nodeIpRaw = (await infraService.runKubectl(
          ['get', 'nodes', '-o', 'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}'],
          '/tmp/kubeconfig-provisioning-lunorica',
        )).trim();
        await giteaService.createWebhook(owner, giteaRepo, webhookUrlFor(nodeIpRaw, process.env.PORT || 3001, id), webhookSecret);

        repoFields = { giteaOwner: owner, giteaRepo, webhookSecretEnc: encryptValue(webhookSecret, jwtSecret) };
      }

      const project = await db.saveProjectInfo({
        id,
        name,
        ownerId: userOf(req).id,
        ...repoFields,
        ...(isWorkspaceLanguage(await new WorkspaceImageService(db).list(userOf(req).id), language)
          ? { language }
          : {}),
        appType: wantsRepo ? 'gitapp' : 'local',
        ...(targetClusterId ? { targetClusterId } : {}),
        ...(targetNamespace ? { targetNamespace } : {}),
        ...(executionTarget ? { executionTarget } : {}),
        ...(executionTarget && (executionApproval === 'auto' || executionApproval === 'plan')
          ? { executionApproval }
          : {}),
        autoDeployOnBuild: autoDeployOnBuild === true,
        createdAt: new Date().toISOString(),
      });
      res.status(201).json(project);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/:id', asyncRoute(async (req, res) => {
    const project = await getOwnedProject(idOf(req), userOf(req));
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { executionTargetDeviceId, executionTargetPath, executionApproval, executionTargetEgress } = req.body ?? {};
    const patch: Record<string, unknown> = { id: project.id };

    if (executionTargetDeviceId !== undefined) {
      if (executionTargetDeviceId) {
        const owned = (await db.getLocalAgentDevices())
          .find((d: any) => d.id === executionTargetDeviceId && d.ownerId === userOf(req).id);
        if (!owned) return res.status(400).json({ error: 'Unknown local execution device' });

        const path = typeof executionTargetPath === 'string' && executionTargetPath.trim()
          ? executionTargetPath.trim()
          : undefined;

        if (claimedByAnotherProject(await db.getProjects(), executionTargetDeviceId, path, project.id)) {
          return res.status(409).json({ error: 'That machine (at that path) is already the execution target for another project.' });
        }

        const egressError = validateLocalEgressRules(executionTargetEgress);
        if (egressError) return res.status(400).json({ error: egressError });

        patch.executionTarget = {
          kind: 'local-device',
          deviceId: owned.id,
          ...(path ? { path } : {}),
          ...(Array.isArray(executionTargetEgress) && executionTargetEgress.length
            ? { egress: executionTargetEgress }
            : {}),
        };
      } else {
        patch.executionTarget = { kind: 'k8s' };
      }
    }

    if (executionApproval === 'auto' || executionApproval === 'plan') {
      patch.executionApproval = executionApproval;
    }

    const updated = await db.saveProjectInfo(patch as any);
    res.json(updated);
  }));

  router.post('/:id/runs/:runId/promote', async (req, res) => {
    try {
      const user = userOf(req);
      const project = await getOwnedProject(req.params.id, user);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const runs = await db.getPipelineRuns();
      const run = runs.find((r: any) => r.id === req.params.runId && r.projectId === project.id);
      if (!run) return res.status(404).json({ error: 'Run not found' });

      const info = await temporalBridge.promoteProjectBuild(project, run, user?.id);
      res.status(202).json({ message: 'Promoting build to deployment', workflowId: info.id, deploymentId: info.resourceId });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}
