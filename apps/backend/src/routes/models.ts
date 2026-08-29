import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import {
  getHfModelSize, getHfModelConfig, estimateKvCacheBytes, searchHfModels,
  getExl3ModelCollection, getHfModelBranches,
} from '../lib/huggingface.js';
import { isWorkspaceLanguage } from '../lib/workspace-spec.js';

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export function modelsRouter(deps: Record<string, any>): Router {
  const { modelService, db, credentialService } = deps;
  const router = Router();

  router.get('/', async (req, res) => {
    try {
      res.json(await modelService.list(userOf(req).id));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/extractor', async (req, res) => {
    try {
      const user = userOf(req);
      const { modelId } = req.body ?? {};
      if (modelId !== null && typeof modelId !== 'string') {
        return res.status(400).json({ error: 'modelId must be a string, or null to clear' });
      }
      if (modelId) {
        const owned = (await modelService.list(user.id)).some((m: any) => m.id === modelId);
        if (!owned) return res.status(404).json({ error: 'Model not found' });
      }
      const record = await db.getUserById(user.id);
      if (!record) return res.status(404).json({ error: 'User not found' });
      await db.saveUser({ ...record, ...(modelId ? { extractionModelId: modelId } : { extractionModelId: undefined }) });
      res.json({ success: true, extractionModelId: modelId || null });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/extractor', async (req, res) => {
    const record = await db.getUserById(userOf(req).id);
    res.json({ extractionModelId: record?.extractionModelId ?? null });
  });

  router.get('/hf-size', async (req, res) => {
    try {
      const repo = req.query.repo as string;
      if (!repo) return res.status(400).json({ error: 'repo is required' });
      const revision = req.query.revision as string | undefined;
      const user = userOf(req);
      const resolved = await credentialService.resolveCredentials(user.id, 'huggingface');
      const size = await getHfModelSize(repo, revision, resolved.env.HF_TOKEN);

      const maxSeqLen = req.query.maxSeqLen ? parseInt(req.query.maxSeqLen as string) : undefined;
      const gpuCount = Math.max(parseInt((req.query.gpuCount as string) || '1'), 1);
      let kvCacheBytesPerGpu: number | undefined;
      let weightBytesPerGpu: number | undefined;
      if (maxSeqLen) {
        try {
          const config = await getHfModelConfig(repo, revision, resolved.env.HF_TOKEN);
          kvCacheBytesPerGpu = estimateKvCacheBytes(config, maxSeqLen, req.query.cacheMode as string | undefined) / gpuCount;
          weightBytesPerGpu = size.totalBytes / gpuCount;
        } catch { /* ignored */ }
      }

      res.json({ ...size, kvCacheBytesPerGpu, weightBytesPerGpu });
    } catch (err: any) {
      res.status(500).json({ error: err.response?.status === 404 ? `Model or revision not found: ${req.query.repo}@${req.query.revision || 'main'}` : err.message });
    }
  });

  router.get('/search', async (req, res) => {
    try {
      const q = (req.query.q as string) || '';
      const appType = req.query.appType as string;
      const results = appType === 'tabbyapi'
        ? await getExl3ModelCollection(q)
        : await searchHfModels(q, { ...(appType === "vllm" ? { pipelineTag: "text-generation" } : {}), limit: 20 });
      res.json(results);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/hf-branches', async (req, res) => {
    try {
      const repo = req.query.repo as string;
      if (!repo) return res.status(400).json({ error: 'repo is required' });
      const user = userOf(req);
      const resolved = await credentialService.resolveCredentials(user.id, 'huggingface');
      const branches = await getHfModelBranches(repo, resolved.env.HF_TOKEN);
      res.json(branches);
    } catch (err: any) {
      res.status(500).json({ error: err.response?.status === 404 ? `Model not found: ${req.query.repo}` : err.message });
    }
  });

  return router;
}
