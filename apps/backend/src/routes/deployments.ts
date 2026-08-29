import { Router, type Request } from 'express';
import type { Server as SocketServer } from 'socket.io';
import { asyncRoute } from '../middleware/async-route.js';
import { CapacityError } from '../lib/cluster-capacity.js';
import { APP_SETTINGS_SCHEMAS, NO_WEB_UI_APP_TYPES } from '../lib/app-schemas.js';
import { validateAppSettings } from '../lib/app-settings-schema.js';
import { parseQuantity, planHostMemory } from '../lib/host-memory-plan.js';
import { TABBYAPI_DEFAULT_MAX_SEQ_LEN } from '../lib/app-env.js';
import type { Database } from '../lib/db-interface.js';
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

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export function deploymentsRouter(deps: DeploymentsRouterDeps): Router {
  const { appService, clusterService, appExposureService, infraService, temporalBridge, db, io } = deps;
  const router = Router();

  router.get('/', asyncRoute(async (req, res) => res.json(await appService.getAll(userOf(req).id, io))));

  router.post('/', async (req, res) => {
    try {
      const user = userOf(req);
      const targetCluster = await clusterService.getById(req.body.clusterId, user.id);
      if (!targetCluster) return res.status(404).json({ error: 'Cluster not found' });
      const info = await temporalBridge.deployApp(req.body, user?.id);
      res.status(202).json({
        message: 'Deployment started',
        deploymentName: req.body.name,
        id: info.resourceId,
        workflowId: info.id,
        state: 'running',
      });
    } catch (err: any) {
      if (err instanceof CapacityError) {
        return res.status(400).json({ error: err.message });
      }
      res.status(503).json({ error: `Temporal app deploy unavailable: ${err.message}` });
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
    } catch (err: any) {
      try {
        await appService.abort(idOf(req), userOf(req).id, io);
        res.json({ success: true, message: 'Deployment deleted' });
      } catch (fallbackErr: any) {
        res.status(503).json({ error: `Deployment destruction unavailable: ${err.message}` });
      }
    }
  });

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
      const mode = req.body?.mode === 'local' ? 'local' : 'public';
      const result = mode === 'local' ? await appExposureService.exposeLocal(idOf(req)) : await appExposureService.exposePublic(idOf(req));
      res.json(result);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  router.post('/:id/unexpose', async (req, res) => {
    try {
      if (!(await appService.getById(idOf(req), userOf(req).id))) return res.status(404).json({ error: 'Deployment not found' });
      const mode = req.body?.mode === 'local' ? 'local' : 'public';
      const result = mode === 'local' ? await appExposureService.unexposeLocal(idOf(req)) : await appExposureService.unexposePublic(idOf(req));
      res.json(result);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  router.patch('/:id/exposure-path', async (req, res) => {
    try {
      if (!(await appService.getById(idOf(req), userOf(req).id))) return res.status(404).json({ error: 'Deployment not found' });
      const { path } = req.body;
      res.json(await appExposureService.updateExposurePath(idOf(req), path));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/:id/modules', asyncRoute(async (req, res) => {
    const { modules } = req.body;
    res.status(202).json(await appService.updateModules(idOf(req), modules, userOf(req).id, io));
  }));

  router.patch('/:id/storage', async (req, res) => {
    try {
      if (!(await appService.getById(idOf(req), userOf(req).id))) return res.status(404).json({ error: 'Deployment not found' });
      const info = await temporalBridge.resizeDisk(idOf(req), req.body.storage);
      res.status(202).json({
        message: 'Resize started',
        deploymentId: idOf(req),
        workflowId: info.id,
        state: 'running',
      });
    } catch (err: any) {
      res.status(503).json({ error: `Temporal resize disk unavailable: ${err.message}` });
    }
  });

  router.get('/:id/resource-plan', async (req, res) => {
    const user = userOf(req);
    const dep = (await db.getDeployments()).find((d) => d.id === idOf(req) && d.ownerId === user.id);
    if (!dep) return res.status(404).json({ error: 'Deployment not found' });
    if (dep.appType !== 'tabbyapi') return res.json({ applicable: false });

    let modelBytes: number | undefined;
    try {
      const { getHfModelSize } = await import('../lib/huggingface.js');
      modelBytes = (await getHfModelSize(dep.tabbyModel!, dep.tabbyRevision, dep.tabbyHfToken)).totalBytes;
    } catch { /* falls back to the conservative assumption inside the plan */ }

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
    } catch { /* no node reading means no budget, which the plan reports honestly */ }

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
      const CONFIGURABLE_FIELDS = [
        'storage', 'webRepo', 'webTag', 'dbRepo', 'dbTag',
        'vllmModel', 'vllmGpuCount', 'vllmGpuVendor', 'vllmCachePvc', 'vllmHfToken',
        'vllmMaxModelLen', 'vllmGpuMemUtil', 'vllmExtraArgs', 'openWebuiTargetId', 'hermesTargetId',
        'vllmToolCallingEnabled', 'vllmToolCallParser', 'vllmServedModelName',
        'vllmMaxNumSeqs', 'vllmDtype', 'vllmEnablePrefixCaching',
        'tabbyModel', 'tabbyRevision', 'tabbyGpuCount', 'tabbyHfToken', 'tabbyCachePvc',
        'tabbyImageTag', 'tabbyCacheMode', 'tabbyMaxSeqLen', 'tabbyMaxBatchSize',
        'tabbyReasoning', 'tabbyToolFormat', 'tabbyInlineModelLoading', 'tabbyDisableAuth',
        'tabbyMemoryLimit', 'tabbyShmSize', 'tabbyCpuLimit',
        'tabbyExtraEnv',
        'webuiEnableWebSearch', 'webuiWebSearchEngine', 'webuiWebSearchApiKey',
        'appSettings',
      ];
      const patch: Record<string, any> = {};
      for (const key of CONFIGURABLE_FIELDS) {
        if (req.body[key] !== undefined) patch[key] = req.body[key];
      }

      if (patch.appSettings !== undefined) {
        const existing = await appService.getById(idOf(req), userOf(req).id);
        const schema = APP_SETTINGS_SCHEMAS[existing?.appType ?? ''];
        if (!schema) {
          return res.status(400).json({ error: `App type "${existing?.appType}" has no settings schema` });
        }
        const { values, errors } = validateAppSettings(schema, patch.appSettings);
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
    } catch (err: any) {
      res.status(503).json({ error: `Temporal config update unavailable: ${err.message}` });
    }
  });

  return router;
}
