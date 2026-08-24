import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';

/** The `:id` from the path, narrowed once — Express types `req.params` loosely inside asyncRoute. */
const idOf = (req: Request): string => String(req.params.id ?? '');

/** The user `requireAuth` put on the request. */
const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

/**
 * Live VPS plan and price search across providers. See VpsCatalogService for why it is queried rather than hardcoded.
 */
export function vpsCatalogRouter(deps: Record<string, any>): Router {
  const { vpsCatalogService } = deps;
  const router = Router();

  /**
   * Live VPS plan/price search across providers — see VpsCatalogService for why this is queried
   * rather than hardcoded. Public catalogues (Linode, Vultr) always appear; Hetzner and
   * DigitalOcean appear once the requesting user has stored a token for them, and the `sources`
   * array explains any provider that's missing.
   */
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
      // search() is meant to absorb per-provider failures into `sources` and still return, so
      // reaching here means something structural broke. Logged with the stack because the response
      // body alone left no server-side trace of an empty catalogue.
      console.error('[vps-catalog] search failed:', err.stack ?? err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /** Forces a re-fetch on the next search — backs the UI's Refresh button. */
  router.post('/refresh', async (_req, res) => {
    vpsCatalogService.clearCache();
    res.json({ ok: true });
  });

  return router;
}
