import { Router, type Request } from 'express';
import type { Server as SocketServer } from 'socket.io';
import { asyncRoute, at, type Database, type DeploymentMetadata, listAt, principalFrom } from '../../platform/index.js';
import { CapacityError } from '../lib/cluster-capacity.js';
import { APP_SETTINGS_SCHEMAS, NO_WEB_UI_APP_TYPES } from '../lib/app-schemas.js';
import { deployRequestFrom } from '../lib/app-namespace.js';
import { withoutDeploymentSecrets } from '../lib/deployment-secrets.js';
import { validateAppSettings } from '../lib/app-settings-schema.js';
import { parseQuantity, planHostMemory } from '../lib/host-memory-plan.js';
import { TABBYAPI_DEFAULT_MAX_SEQ_LEN } from '../lib/app-env.js';
import { visibleAppSpecs } from '../lib/app-spec.js';
import { deploymentConfigPatch, isTexts } from '../lib/deployment-config.js';
import { ignore } from '@koala/engine-core/failures';
import type { AppService } from '../services/AppService.js';
import type { ClusterService } from '../services/ClusterService.js';
import type { AppExposureService } from '../services/AppExposureService.js';
import type { InfrastructureService } from '../services/InfrastructureService.js';
import type { TemporalBridge } from '../services/TemporalBridge.js';

export interface DeploymentsRouterDeps {
  appService: AppService;
  clusterService: Pick<ClusterService, 'getById'>;
  appExposureService: AppExposureService;
  infraService: Pick<InfrastructureService, 'runKubectl' | 'runCommand'>;
  temporalBridge: TemporalBridge;
  db: Database;
  io: SocketServer;
}

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string } =>
  (req as unknown as { user: { id: string; email: string } }).user;

export function deploymentsRouter(deps: DeploymentsRouterDeps): Router {
  const { appService, clusterService, appExposureService, infraService, temporalBridge, db, io } = deps;
  const router = Router();
  router.use((_req, res, next) => {
    const send = res.json.bind(res);
    res.json = (body?: unknown) => send(withoutDeploymentSecrets(body));
    next();
  });

  router.get('/', asyncRoute(async (req, res) => res.json(await appService.getAll(userOf(req).id, io))));

  // The one place both koala (list_infrastructure's deployable field) and the deploy wizard read
  // "what's deployable" from — see lib/app-spec.ts's visibleAppSpecs (built-ins + this user's own).
  router.get('/catalogue', asyncRoute(async (req, res) => {
    const specs = visibleAppSpecs(await db.infrastructure.getAppSpecs(), userOf(req).id);
    res.json(specs.map((s) => ({ ...s, deploysFromSpec: Boolean(s.spec) })));
  }));

  router.post('/', async (req, res) => {
    try {
      const user = userOf(req);
      const asked = deployRequestFrom(req.body);
      if ('problem' in asked) return res.status(400).json({ error: asked.problem });
      const targetCluster = await clusterService.getById(String(asked.request.clusterId ?? ''), principalFrom(req), 'deploy-to');
      if (!targetCluster) return res.status(404).json({ error: 'Cluster not found' });
      const info = await temporalBridge.deployApp(asked.request, user?.id);
      res.status(202).json({
        message: 'Deployment started',
        deploymentName: asked.request.name,
        id: info.resourceId,
        workflowId: info.id,
        state: 'running',
      });
    } catch (err) {
      if (err instanceof CapacityError) {
        return res.status(400).json({ error: err.message });
      }
      res.status(503).json({ error: `Temporal app deploy unavailable: ${(err as Error).message}` });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const dep = await appService.getById(idOf(req), userOf(req).id);
      if (!dep) return res.status(404).json({ error: 'Deployment not found' });
      if (dep.status === 'deploying') {
        await appService.abort(idOf(req), userOf(req).id, io);
        return res.json({ success: true, message: 'Deployment aborted' });
      }
      const info = await temporalBridge.destroyApp(idOf(req));
      res.status(202).json({
        message: 'Destroying app',
        deploymentId: idOf(req),
        workflowId: info.id,
        state: 'running',
      });
    } catch (err) {
      try {
        await appService.abort(idOf(req), userOf(req).id, io);
        res.json({ success: true, message: 'Deployment deleted' });
      } catch (fallbackErr) {
        res.status(503).json({ error: `Deployment destruction unavailable: ${(err as Error).message}; deleting its record failed too: ${(fallbackErr as Error).message}` });
      }
    }
  });

  router.get('/:id/sign-in', asyncRoute(async (req, res) => {
    const signIns = await appService.signIns(idOf(req), userOf(req).id);
    if (!signIns) return res.status(404).json({ error: 'Deployment not found' });
    return res.set('Cache-Control', 'no-store').json({ signIns });
  }));
  router.get('/:id/helm', asyncRoute(async (req, res) => res.json({ content: await appService.getHelmStatus(idOf(req), userOf(req).id) })));
  router.get('/:id/diagnostics', asyncRoute(async (req, res) => res.json({ content: await appService.getDiagnostics(idOf(req), userOf(req).id) })));
  router.get('/:id/pods', async (req, res) => {
    try { res.json(await appService.listPods(idOf(req), userOf(req).id)); } catch { res.status(500).json({ error: 'Failed to list pods' }); }
  });

  router.post('/:id/expose', async (req, res) => {
    try {
      const dep = await appService.getById(idOf(req), userOf(req).id);
      if (!dep) return res.status(404).json({ error: 'Deployment not found' });
      if (NO_WEB_UI_APP_TYPES.has(dep.appType ?? '')) {
        return res.status(400).json({
          error: `"${dep.appType}" has no HTTP interface to expose — players connect directly to the cluster node on its game port.`,
        });
      }
      const mode = at(req.body, 'mode') === 'local' ? 'local' : 'public';
      const result = mode === 'local' ? await appExposureService.exposeLocal(idOf(req)) : await appExposureService.exposePublic(idOf(req));
      res.json(result);
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });
  router.post('/:id/unexpose', async (req, res) => {
    try {
      if (!(await appService.getById(idOf(req), userOf(req).id))) return res.status(404).json({ error: 'Deployment not found' });
      const mode = at(req.body, 'mode') === 'local' ? 'local' : 'public';
      const result = mode === 'local' ? await appExposureService.unexposeLocal(idOf(req)) : await appExposureService.unexposePublic(idOf(req));
      res.json(result);
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });
  router.patch('/:id/exposure-path', async (req, res) => {
    try {
      if (!(await appService.getById(idOf(req), userOf(req).id))) return res.status(404).json({ error: 'Deployment not found' });
      const path = at(req.body, 'path');
      if (typeof path !== 'string') return res.status(400).json({ error: 'path must be text' });
      res.json(await appExposureService.updateExposurePath(idOf(req), path));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.patch('/:id/modules', asyncRoute(async (req, res) => {
    const modules = at(req.body, 'modules');
    if (!Array.isArray(modules) || !modules.every((m) => typeof m === 'string')) return res.status(400).json({ error: 'modules must be a list of module names' });
    res.status(202).json(await appService.updateModules(idOf(req), listAt(modules).map(String), userOf(req).id, io));
  }));

  router.patch('/:id/storage', async (req, res) => {
    try {
      if (!(await appService.getById(idOf(req), userOf(req).id))) return res.status(404).json({ error: 'Deployment not found' });
      const storage = at(req.body, 'storage');
      if (!isTexts(storage)) return res.status(400).json({ error: 'storage must be an object of sizes' });
      const info = await temporalBridge.resizeDisk(idOf(req), storage);
      res.status(202).json({
        message: 'Resize started',
        deploymentId: idOf(req),
        workflowId: info.id,
        state: 'running',
      });
    } catch (err) {
      res.status(503).json({ error: `Temporal resize disk unavailable: ${(err as Error).message}` });
    }
  });

  router.get('/:id/resource-plan', async (req, res) => {
    const dep = await appService.getById(idOf(req), userOf(req).id);
    if (!dep) return res.status(404).json({ error: 'Deployment not found' });
    if (dep.appType !== 'tabbyapi') return res.json({ applicable: false });

    let modelBytes: number | undefined;
    try {
      const { getHfModelSize } = await import('../lib/huggingface.js');
      modelBytes = (await getHfModelSize(dep.tabbyModel!, dep.tabbyRevision, dep.tabbyHfToken)).totalBytes;
    } catch (failure) {
      ignore('without the model\'s size the plan assumes a large model and says the size lookup failed')(failure);
    }

    let allocatableBytes: number | undefined;
    try {
      const nodes = await infraService.runCommand("kubectl", [
        'get', 'nodes', '-o', 'jsonpath={.items[*].status.allocatable.memory}',
      ], `resource-plan-${dep.id}`) as { stdout: string; exitCode: number };
      if (nodes.exitCode === 0) {
        const sizes = nodes.stdout.trim().split(/\s+/).map((q) => parseQuantity(q))
          .filter((n): n is number => n !== undefined);
        if (sizes.length) allocatableBytes = Math.min(...sizes);
      }
    } catch (failure) {
      ignore('without the nodes\' memory the plan has no budget to check and says so')(failure);
    }

    const plan = planHostMemory({
      modelBytes,
      gpuCount: Number(dep.tabbyGpuCount) || 1,
      maxSeqLen: Number(dep.tabbyMaxSeqLen) || TABBYAPI_DEFAULT_MAX_SEQ_LEN,
      inlineModelLoading: dep.tabbyInlineModelLoading === true,
      allocatableBytes,
    });

    res.json({
      applicable: true,
      memoryLimit: `${Math.ceil(plan.limitBytes / 1e9)}G`,
      shmSize: `${Math.ceil(plan.shmBytes / 1024 ** 3)}Gi`,
      cpuLimit: '10',
      basis: plan.basis,
      ...(plan.refusal ? { refusal: plan.refusal } : {}),
    });
  });

  router.patch('/:id/config', async (req, res) => {
    try {
      if (!(await appService.getById(idOf(req), userOf(req).id))) return res.status(404).json({ error: 'Deployment not found' });
      const read = deploymentConfigPatch(req.body);
      if ('problem' in read) return res.status(400).json({ error: read.problem });
      const patch: Partial<DeploymentMetadata> = read.patch;

      if (read.appSettings !== undefined) {
        const existing = await appService.getById(idOf(req), userOf(req).id);
        const schema = APP_SETTINGS_SCHEMAS[existing?.appType ?? ''];
        if (!schema) {
          return res.status(400).json({ error: `App type "${existing?.appType}" has no settings schema` });
        }
        const { values, errors } = validateAppSettings(schema, read.appSettings);
        if (errors.length > 0) {
          return res.status(400).json({ error: 'Invalid settings', details: errors });
        }
        patch.appSettings = values;
      }

      const info = await temporalBridge.updateConfigAndSync(idOf(req), patch);
      res.status(202).json({
        message: 'Config updated, sync started',
        deploymentId: idOf(req),
        workflowId: info.id,
        state: 'running',
      });
    } catch (err) {
      res.status(503).json({ error: `Temporal config update unavailable: ${(err as Error).message}` });
    }
  });

  return router;
}
