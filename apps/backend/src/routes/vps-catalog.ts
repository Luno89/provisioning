import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export function vpsCatalogRouter(deps: Record<string, any>): Router {
  const { vpsCatalogService } = deps;
  const router = Router();

  router.get('/', async (req, res) => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const num = (v: string | undefined) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : undefined);
      const result = await vpsCatalogService.search(userOf(req).id, {
        ...(num(q.minRamGb) !== undefined ? { minRamGb: num(q.minRamGb)! } : {}),
        ...(num(q.maxRamGb) !== undefined ? { maxRamGb: num(q.maxRamGb)! } : {}),
        ...(num(q.minVcpu) !== undefined ? { minVcpu: num(q.minVcpu)! } : {}),
        ...(num(q.minDiskGb) !== undefined ? { minDiskGb: num(q.minDiskGb)! } : {}),
        ...(num(q.maxPriceMonthly) !== undefined ? { maxPriceMonthly: num(q.maxPriceMonthly)! } : {}),
        ...(q.location ? { location: q.location } : {}),
        ...(q.arch ? { arch: q.arch as any } : {}),
        ...(q.cpuType ? { cpuType: q.cpuType as any } : {}),
        ...(q.hasGpu === 'true' ? { hasGpu: true } : q.hasGpu === 'false' ? { hasGpu: false } : {}),
        ...(num(q.minGpuVramGb) !== undefined ? { minGpuVramGb: num(q.minGpuVramGb)! } : {}),
        ...(q.provider ? { provider: q.provider } : {}),
        ...(q.provisionableOnly === 'true' ? { provisionableOnly: true } : {}),
        ...(q.hourlyOnly === 'true' ? { hourlyOnly: true } : {}),
        ...(q.sort ? { sort: q.sort as any } : {}),
        ...(q.sortDir === 'asc' || q.sortDir === 'desc' ? { sortDir: q.sortDir } : {}),
        ...(num(q.limit) !== undefined ? { limit: num(q.limit)! } : {}),
      });
      res.json(result);
    } catch (err: any) {
      console.error('[vps-catalog] search failed:', err.stack ?? err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/refresh', async (_req, res) => {
    vpsCatalogService.clearCache();
    res.json({ ok: true });
  });

  return router;
}
