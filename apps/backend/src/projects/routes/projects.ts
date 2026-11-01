import { Router, type Request } from 'express';
import { allowed, asyncRoute, fieldsOf, principalFrom, trimmedText } from '../../platform/index.js';
import type { Database, LocalEgressRule, LocalAgentDeviceMetadata, PartialInfo, Principal, ProjectMetadata } from '../../platform/index.js';
import { isWorkspaceLanguage, WorkspaceImageService } from '../../engine/index.js';
import { v4 as uuidv4 } from 'uuid';
import { rollupProjectStatus, deploymentForProject } from '../lib/project-status.js';
import { namesTargetCluster, targetClusterProblem } from '../lib/project-shipping.js';
import { validateLocalEgressRules } from '../../infrastructure/index.js';
import type { ClusterService, TemporalBridge } from '../../infrastructure/index.js';
import type { ProjectRemovalService } from '../services/ProjectRemovalService.js';
import type { ProjectRepoService } from '../services/ProjectRepoService.js';
import type { ProjectChannelService } from '../services/ProjectChannelService.js';
import type { GiteaService } from '../services/GiteaService.js';

export interface ProjectsRouterDeps {
  db: Database;
  getOwnedProject: (id: string, principal: Principal) => Promise<ProjectMetadata | undefined>;
  projectRepoService: Pick<ProjectRepoService, 'createProject'>;
  temporalBridge: Pick<TemporalBridge, 'promoteProjectBuild'>;
  giteaService: Pick<GiteaService, 'getCommit'>;
  clusterService: Pick<ClusterService, 'getById'>;
  channels?: Pick<ProjectChannelService, 'ensure'> | undefined;
  removal?: Pick<ProjectRemovalService, 'preview' | 'remove'> | undefined;
}

type ExecutionTarget = NonNullable<ProjectMetadata['executionTarget']>;

const textOf = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

const approvalOf = (value: unknown): 'auto' | 'plan' | undefined =>
  (value === 'auto' || value === 'plan' ? value : undefined);

const localTarget = (deviceId: string, path: string | undefined, egress: unknown): ExecutionTarget => ({
  kind: 'local-device',
  deviceId,
  ...(path ? { path } : {}),
  ...(Array.isArray(egress) && egress.length ? { egress: egress as LocalEgressRule[] } : {}),
});

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string } =>
  (req as unknown as { user: { id: string; email: string } }).user;

const claimedByAnotherProject = (
  projects: readonly ProjectMetadata[], deviceId: string, path: string | undefined, excludeProjectId?: string,
): boolean =>
  projects.some((p) => p.id !== excludeProjectId
    && p.executionTarget?.kind === 'local-device'
    && p.executionTarget.deviceId === deviceId
    && (p.executionTarget.path ?? '') === (path ?? ''));

export function projectsRouter(deps: ProjectsRouterDeps): Router {
  const {
    db, projectRepoService, temporalBridge, getOwnedProject,
    giteaService, channels, clusterService,
  } = deps;
  const ownDevice = async (req: Request, deviceId: string): Promise<LocalAgentDeviceMetadata | undefined> => (await db.machines.getLocalAgentDevices())
    .find((d) => d.id === deviceId && allowed(principalFrom(req), 'see', { kind: 'record', noun: 'machine', ownerId: d.ownerId }));
  const router = Router();

  router.get('/', async (req, res) => {
    const projects = await db.projects.getProjects();
    const mine = projects.filter((p) => allowed(principalFrom(req), 'see', { kind: 'project', ownerId: p.ownerId }));
    const [runs, deployments] = await Promise.all([db.releases.getPipelineRuns(), db.infrastructure.getDeployments()]);
    res.json(mine.map((p) => ({
      ...p,
      ...rollupProjectStatus(p, runs, deploymentForProject(p, deployments)),
    })));
  });

  router.get('/:id/runs', async (req, res) => {
    const project = await getOwnedProject(idOf(req), principalFrom(req));
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const runs = (await db.releases.getPipelineRuns())
      .filter((r) => r.projectId === req.params.id)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    const enriched = await Promise.all(runs.map(async (run) => {
      if (run.commitMessage || !run.commitSha || !project.giteaOwner || !project.giteaRepo) return run;
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
      const body = fieldsOf(req.body);
      const { createRepo, autoDeployOnBuild, language: language_, executionTargetEgress } = body;
      const name = textOf(body.name);
      const giteaRepo = textOf(body.giteaRepo);
      const targetClusterId = textOf(body.targetClusterId);
      const executionTargetDeviceId = textOf(body.executionTargetDeviceId);
      const executionApproval = approvalOf(body.executionApproval);
      if (!name) return res.status(400).json({ error: 'name is required' });
      const deployable = namesTargetCluster(body.targetClusterId) && Boolean(targetClusterId && await clusterService.getById(targetClusterId, principalFrom(req), 'deploy-to'));
      const clusterProblem = targetClusterProblem(body.targetClusterId, deployable);
      if (clusterProblem) return res.status(400).json({ error: clusterProblem });
      if (!giteaRepo && !executionTargetDeviceId) {
        return res.status(400).json({ error: 'giteaRepo is required unless the project runs on a registered local machine' });
      }

      const path = trimmedText(body.executionTargetPath);

      let executionTarget: ExecutionTarget | undefined;
      if (executionTargetDeviceId) {
        const owned = await ownDevice(req, executionTargetDeviceId);
        if (!owned) return res.status(400).json({ error: 'Unknown local execution device' });

        if (claimedByAnotherProject(await db.projects.getProjects(), executionTargetDeviceId, path)) {
          return res.status(409).json({ error: 'That machine (at that path) is already the execution target for another project.' });
        }

        const egressError = validateLocalEgressRules(executionTargetEgress);
        if (egressError) return res.status(400).json({ error: egressError });

        executionTarget = localTarget(owned.id, path, executionTargetEgress);
      }

      const language = isWorkspaceLanguage(await new WorkspaceImageService(db).list(userOf(req).id), language_) ? language_ : undefined;
      const extra = {
        ...(executionTarget ? { executionTarget } : {}),
        ...(executionTarget && executionApproval ? { executionApproval } : {}),
      };

      const project = giteaRepo
        ? await projectRepoService.createProject(userOf(req).id, {
          name,
          repo: giteaRepo,
          ...(createRepo ? {} : { existing: true }),
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
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.patch('/:id', asyncRoute(async (req, res) => {
    const project = await getOwnedProject(idOf(req), principalFrom(req));
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const body = fieldsOf(req.body);
    const { executionTargetEgress } = body;
    const executionApproval = approvalOf(body.executionApproval);
    const patch: PartialInfo<ProjectMetadata> = { id: project.id };

    if (body.executionTargetDeviceId !== undefined) {
      const executionTargetDeviceId = body.executionTargetDeviceId ? String(body.executionTargetDeviceId) : undefined;
      if (executionTargetDeviceId) {
        const owned = await ownDevice(req, executionTargetDeviceId);
        if (!owned) return res.status(400).json({ error: 'Unknown local execution device' });

        const path = trimmedText(body.executionTargetPath);

        if (claimedByAnotherProject(await db.projects.getProjects(), executionTargetDeviceId, path, project.id)) {
          return res.status(409).json({ error: 'That machine (at that path) is already the execution target for another project.' });
        }

        const egressError = validateLocalEgressRules(executionTargetEgress);
        if (egressError) return res.status(400).json({ error: egressError });

        patch.executionTarget = localTarget(owned.id, path, executionTargetEgress);
      } else {
        patch.executionTarget = { kind: 'k8s' };
      }
    }

    if (executionApproval) {
      patch.executionApproval = executionApproval;
    }

    const updated = await db.projects.saveProjectInfo(patch);
    res.json(updated);
  }));

  router.post('/:id/runs/:runId/promote', async (req, res) => {
    try {
      const user = userOf(req);
      const project = await getOwnedProject(idOf(req), principalFrom(req));
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const runs = await db.releases.getPipelineRuns();
      const run = runs.find((r) => r.id === req.params.runId && r.projectId === project.id);
      if (!run) return res.status(404).json({ error: 'Run not found' });
      if (project.removal) return res.status(409).json({ error: 'This project is being deleted' });

      const info = await temporalBridge.promoteProjectBuild(project, run, user?.id);
      res.status(202).json({ message: 'Promoting build to deployment', workflowId: info.id, deploymentId: info.resourceId });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  const { removal } = deps;

  router.get('/:id/removal', asyncRoute(async (req, res) => {
    if (!removal) return res.status(404).json({ error: 'Projects cannot be deleted here' });
    const preview = await removal.preview(userOf(req).id, idOf(req));
    if (!preview) return res.status(404).json({ error: 'Project not found' });
    return res.json(preview);
  }));

  router.delete('/:id', asyncRoute(async (req, res) => {
    if (!removal) return res.status(404).json({ error: 'Projects cannot be deleted here' });
    const confirm = textOf(fieldsOf(req.body).confirm) ?? '';
    const outcome = await removal.remove(userOf(req).id, idOf(req), confirm);
    if (!outcome.ok) return res.status(outcome.refusal.status).json(outcome.refusal);
    return res.status(202).json({ state: outcome.state });
  }));

  return router;
}
