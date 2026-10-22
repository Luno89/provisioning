import { Router, type Request } from 'express';
import { asyncRoute } from '../../platform/middleware/async-route.js';
import { isWorkspaceLanguage } from '../../engine/lib/workspace-image-catalogue.js';
import { WorkspaceImageService } from '../../engine/services/WorkspaceImageService.js';
import { v4 as uuidv4 } from 'uuid';
import { ownsProject } from '../../platform/lib/ownership.js';
import { rollupProjectStatus, deploymentForProject } from '../lib/project-status.js';
import { validateLocalEgressRules } from '../../infrastructure/lib/egress-rules.js';
import type { ProjectRemovalService } from '../services/ProjectRemovalService.js';

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
    db, projectRepoService, temporalBridge, getOwnedProject,
    giteaService, channels,
  } = deps;
  const router = Router();

  router.get('/', async (req, res) => {
    const projects = await db.projects.getProjects();
    const mine = projects.filter((p: any) => ownsProject(p, userOf(req)));
    const [runs, deployments] = await Promise.all([db.releases.getPipelineRuns(), db.getDeployments()]);
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
    const runs = (await db.releases.getPipelineRuns())
      .filter((r: any) => r.projectId === req.params.id)
      .sort((a: any, b: any) => b.startedAt.localeCompare(a.startedAt));

    const enriched = await Promise.all(runs.map(async (run: any) => {
      if (run.commitMessage || !run.commitSha) return run;
      try {
        const commit = await giteaService.getCommit(project.giteaOwner, project.giteaRepo, run.commitSha);
        if (!commit?.message) return run;
        const updated = await db.releases.savePipelineRunInfo({ id: run.id, commitMessage: commit.message });
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
        name, giteaOwner, giteaRepo, createRepo, targetClusterId, autoDeployOnBuild, language: language_,
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

        if (claimedByAnotherProject(await db.projects.getProjects(), executionTargetDeviceId, path)) {
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

      const language = isWorkspaceLanguage(await new WorkspaceImageService(db).list(userOf(req).id), language_) ? language_ : undefined;
      const extra = {
        ...(executionTarget ? { executionTarget } : {}),
        ...(executionTarget && (executionApproval === 'auto' || executionApproval === 'plan') ? { executionApproval } : {}),
      };

      const project = wantsRepo
        ? await projectRepoService.createProject(userOf(req).id, {
          name,
          repo: giteaRepo,
          ...(createRepo ? {} : { existingOwner: giteaOwner || giteaService.adminUsername }),
          ...(language ? { language } : {}),
          ...(targetClusterId ? { targetClusterId } : {}),
          autoDeployOnBuild: autoDeployOnBuild === true,
          description: `Provisioning project: ${name}`,
          extra,
        })
        : await db.projects.saveProjectInfo({
          id: uuidv4(),
          name,
          ownerId: userOf(req).id,
          ...(language ? { language } : {}),
          appType: 'local',
          ...extra,
          autoDeployOnBuild: false,
          createdAt: new Date().toISOString(),
        });
      await channels?.ensure(project);
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

        if (claimedByAnotherProject(await db.projects.getProjects(), executionTargetDeviceId, path, project.id)) {
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

    const updated = await db.projects.saveProjectInfo(patch as any);
    res.json(updated);
  }));

  router.post('/:id/runs/:runId/promote', async (req, res) => {
    try {
      const user = userOf(req);
      const project = await getOwnedProject(req.params.id, user);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const runs = await db.releases.getPipelineRuns();
      const run = runs.find((r: any) => r.id === req.params.runId && r.projectId === project.id);
      if (!run) return res.status(404).json({ error: 'Run not found' });
      if (project.removal) return res.status(409).json({ error: 'This project is being deleted' });

      const info = await temporalBridge.promoteProjectBuild(project, run, user?.id);
      res.status(202).json({ message: 'Promoting build to deployment', workflowId: info.id, deploymentId: info.resourceId });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  const removal = deps.removal as ProjectRemovalService | undefined;

  router.get('/:id/removal', asyncRoute(async (req, res) => {
    if (!removal) return res.status(404).json({ error: 'Projects cannot be deleted here' });
    const preview = await removal.preview(userOf(req).id, idOf(req));
    if (!preview) return res.status(404).json({ error: 'Project not found' });
    return res.json(preview);
  }));

  router.delete('/:id', asyncRoute(async (req, res) => {
    if (!removal) return res.status(404).json({ error: 'Projects cannot be deleted here' });
    const confirm = typeof req.body?.confirm === 'string' ? req.body.confirm : '';
    const outcome = await removal.remove(userOf(req).id, idOf(req), confirm);
    if (!outcome.ok) return res.status(outcome.refusal.status).json(outcome.refusal);
    return res.status(202).json({ state: outcome.state });
  }));

  return router;
}
