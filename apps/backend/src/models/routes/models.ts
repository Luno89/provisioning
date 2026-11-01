import { Router, type Request } from 'express';
import { machineChoice } from '@koala/agent-engine/procedure';
import { ignore } from '@koala/engine-core/failures';
import { asyncRoute, at, type Database } from '../../platform/index.js';
import type { CredentialService } from '../../infrastructure/index.js';
import type { MachineService } from '../../machines/index.js';
import {
  getHfModelSize, getHfModelConfig, estimateKvCacheBytes, searchHfModels,
  getExl3ModelCollection, getHfModelBranches,
} from '../../infrastructure/lib/huggingface.js';

const userOf = (req: Request): { id: string; email: string } =>
  (req as unknown as { user: { id: string; email: string } }).user;

export interface ModelsRouterDeps {
  modelService: { list(userId: string): Promise<Array<{ id: string }>> };
  db: Pick<Database, 'accounts'>;
  credentialService: Pick<CredentialService, 'resolveCredentials'>;
  machines?: Pick<MachineService, 'choiceProblem'> | undefined;
  rateLimits: (ownerId: string) => unknown;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const statusOf = (err: unknown): unknown => at(at(err, 'response'), 'status');

const queryText = (req: Request, key: string): string | undefined => {
  const value = req.query[key];
  return typeof value === 'string' ? value : undefined;
};

export function modelsRouter(deps: ModelsRouterDeps): Router {
  const { modelService, db, credentialService } = deps;
  const router = Router();

  router.get('/rate-limits', asyncRoute(async (req, res) => {
    res.json({ buckets: deps.rateLimits(userOf(req).id) });
  }));

  router.get('/', asyncRoute(async (req, res) => {
    try {
      res.json(await modelService.list(userOf(req).id));
    } catch (err) {
      res.status(500).json({ error: messageOf(err) });
    }
  }));

  /**
   * The account's default engine. A pack that names no `model.endpointId` of its own runs on this,
   * so switching every pack from one provider to another is this one setting rather than an edit
   * per pack. A pack that does name one still wins — see `routeProvider`.
   */
  router.put('/default', asyncRoute(async (req, res) => {
    const user = userOf(req);
    const modelId = at(req.body, 'modelId');
    if (modelId !== null && typeof modelId !== 'string') {
      return res.status(400).json({ error: 'modelId must be a string, or null to clear' });
    }
    const onMachine = machineChoice(modelId);
    if (onMachine) {
      if (!deps.machines) return res.status(400).json({ error: 'this server cannot reach people\'s machines' });
      const problem = await deps.machines.choiceProblem(user.id, onMachine);
      if (problem) return res.status(400).json({ error: problem });
    } else if (modelId) {
      const owned = (await modelService.list(user.id)).some((m) => m.id === modelId);
      if (!owned) return res.status(404).json({ error: 'Model not found' });
    }
    const record = await db.accounts.getUserById(user.id);
    if (!record) return res.status(404).json({ error: 'User not found' });
    const { defaultModelId: _replaced, ...kept } = record;
    await db.accounts.saveUser(modelId ? { ...kept, defaultModelId: modelId } : kept);
    res.json({ success: true, defaultModelId: modelId || null });
  }));

  /**
   * Whether the account default beats a pack's own engine, or only fills in for a pack without one.
   *
   * A flag, deliberately: turning it off returns every pack to the engine it names, which writing
   * the default into each pack could not do.
   */
  router.put('/default/override', asyncRoute(async (req, res) => {
    const override = at(req.body, 'override');
    if (typeof override !== 'boolean') {
      return res.status(400).json({ error: 'override must be true or false' });
    }
    const record = await db.accounts.getUserById(userOf(req).id);
    if (!record) return res.status(404).json({ error: 'User not found' });
    await db.accounts.saveUser({ ...record, globalModelOverride: override });
    res.json({ success: true, globalModelOverride: override });
  }));

  router.get('/default', asyncRoute(async (req, res) => {
    const record = await db.accounts.getUserById(userOf(req).id);
    res.json({
      defaultModelId: record?.defaultModelId ?? null,
      globalModelOverride: record?.globalModelOverride === true,
    });
  }));

  router.put('/extractor', asyncRoute(async (req, res) => {
    try {
      const user = userOf(req);
      const modelId = at(req.body, 'modelId');
      if (modelId !== null && typeof modelId !== 'string') {
        return res.status(400).json({ error: 'modelId must be a string, or null to clear' });
      }
      if (modelId) {
        const owned = (await modelService.list(user.id)).some((m) => m.id === modelId);
        if (!owned) return res.status(404).json({ error: 'Model not found' });
      }
      const record = await db.accounts.getUserById(user.id);
      if (!record) return res.status(404).json({ error: 'User not found' });
      const { extractionModelId: _replaced, ...kept } = record;
      await db.accounts.saveUser(modelId ? { ...kept, extractionModelId: modelId } : kept);
      res.json({ success: true, extractionModelId: modelId || null });
    } catch (err) {
      res.status(500).json({ error: messageOf(err) });
    }
  }));

  router.get('/extractor', asyncRoute(async (req, res) => {
    const record = await db.accounts.getUserById(userOf(req).id);
    res.json({ extractionModelId: record?.extractionModelId ?? null });
  }));

  router.get('/hf-size', asyncRoute(async (req, res) => {
    try {
      const repo = queryText(req, 'repo');
      if (!repo) return res.status(400).json({ error: 'repo is required' });
      const revision = queryText(req, 'revision');
      const user = userOf(req);
      const resolved = await credentialService.resolveCredentials(user.id, 'huggingface');
      const size = await getHfModelSize(repo, revision, resolved.env.HF_TOKEN);

      const seqLen = queryText(req, 'maxSeqLen');
      const maxSeqLen = seqLen ? parseInt(seqLen) : undefined;
      const gpuCount = Math.max(parseInt(queryText(req, 'gpuCount') || '1'), 1);
      let kvCacheBytesPerGpu: number | undefined;
      let weightBytesPerGpu: number | undefined;
      if (maxSeqLen) {
        const config = await getHfModelConfig(repo, revision, resolved.env.HF_TOKEN).catch(ignore('a model whose config cannot be read is shown without a KV cache estimate'));
        if (config) {
          kvCacheBytesPerGpu = estimateKvCacheBytes(config, maxSeqLen, queryText(req, 'cacheMode')) / gpuCount;
          weightBytesPerGpu = size.totalBytes / gpuCount;
        }
      }

      res.json({ ...size, kvCacheBytesPerGpu, weightBytesPerGpu });
    } catch (err) {
      res.status(500).json({ error: statusOf(err) === 404 ? `Model or revision not found: ${queryText(req, 'repo') ?? ''}@${queryText(req, 'revision') || 'main'}` : messageOf(err) });
    }
  }));

  router.get('/search', asyncRoute(async (req, res) => {
    try {
      const q = queryText(req, 'q') || '';
      const appType = queryText(req, 'appType');
      const results = appType === 'tabbyapi'
        ? await getExl3ModelCollection(q)
        : await searchHfModels(q, { ...(appType === "vllm" ? { pipelineTag: "text-generation" } : {}), limit: 20 });
      res.json(results);
    } catch (err) {
      res.status(500).json({ error: messageOf(err) });
    }
  }));

  router.get('/hf-branches', asyncRoute(async (req, res) => {
    try {
      const repo = queryText(req, 'repo');
      if (!repo) return res.status(400).json({ error: 'repo is required' });
      const user = userOf(req);
      const resolved = await credentialService.resolveCredentials(user.id, 'huggingface');
      const branches = await getHfModelBranches(repo, resolved.env.HF_TOKEN);
      res.json(branches);
    } catch (err) {
      res.status(500).json({ error: statusOf(err) === 404 ? `Model not found: ${queryText(req, 'repo') ?? ''}` : messageOf(err) });
    }
  }));

  return router;
}
