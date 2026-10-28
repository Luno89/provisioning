import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const bootstrap = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
const at = (text: string): number => {
  const index = bootstrap.indexOf(text);
  if (index < 0) throw new Error(`bootstrap no longer contains ${JSON.stringify(text)}`);
  return index;
};

describe('the order routes are mounted in bootstrap', () => {
  it('counts each address\'s open requests before anything else answers, once the proxy is trusted', () => {
    const limit = at('app.use(inFlightLimit());');
    expect(limit).toBeGreaterThan(at("app.set('trust proxy',"));
    expect(limit).toBeLessThan(at("tenant.post('/webhooks/gitea/:projectId'"));
    expect(limit).toBeLessThan(at('app.use(metrics.middleware());'));
    expect(limit).toBeLessThan(at("app.use('/api', ...RATE_LIMITS.map("));
  });

  it('reads the Gitea webhook from the raw body before the JSON parser is mounted', () => {
    expect(at("tenant.post('/webhooks/gitea/:projectId', express.raw(")).toBeLessThan(at('app.use((req, res, next) => jsonParsers['));
  });

  it('reads no JSON body before the guard has said who sent it', () => {
    expect(at('app.use((req, res, next) => jsonParsers[')).toBeGreaterThan(at("app.use('/api', auth.requireAuth);"));
    expect(bootstrap.match(/app\.use\(express\.json\(/g)).toBeNull();
  });

  it('puts the rate limits and the move gate before the guard, and the guard before every API router', () => {
    const guard = at("app.use('/api', auth.requireAuth);");
    expect(at("app.use('/api', ...RATE_LIMITS.map(")).toBeLessThan(guard);
    expect(at('await wireMoveExport({')).toBeLessThan(guard);
    const routers = [...bootstrap.matchAll(/^\s*(?:tenant|app)\.use\('\/api\/[a-z-]+'/gm)].map((match) => match.index!);
    expect(routers.length).toBeGreaterThan(0);
    expect(Math.min(...routers)).toBeGreaterThan(guard);
    const wiring = [...bootstrap.matchAll(/^\s*(?:const \{[^}]*\} = |const \w+ = )?(?:await )?wire[A-Z]\w*\(/gm)].map((match) => match.index!).filter((index) => bootstrap.slice(index, index + 40).indexOf('wireMoveExport') < 0);
    expect(Math.min(...wiring)).toBeGreaterThan(guard);
  });

  it('serves metrics on its own token, not the session', () => {
    expect(at("app.get('/api/metrics', asyncRoute(")).toBeGreaterThan(at("app.use('/api', auth.requireAuth);"));
    expect(bootstrap).toContain('metrics.allowed(req.headers.authorization)');
  });

  it('keeps the frontend catch-all last, after every router', () => {
    const catchAll = at("app.get(/^(?!\\/api).*/, (_req, res) => res.sendFile(");
    const lastRouter = Math.max(...[...bootstrap.matchAll(/^\s*(?:tenant|app)\.use\('\/api\//gm)].map((match) => match.index!));
    expect(catchAll).toBeGreaterThan(lastRouter);
  });
});
