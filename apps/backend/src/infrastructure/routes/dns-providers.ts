import { Router } from 'express';
import type { DnsProviders } from '../services/dns/DnsProviders.js';

export function dnsProvidersRouter(deps: { dns: DnsProviders }): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    res.json(deps.dns.describe());
  });
  return router;
}
