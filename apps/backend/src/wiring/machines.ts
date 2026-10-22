import fs from 'fs/promises';
import path from 'path';
import type express from 'express';
import type { Database } from '../lib/db-interface.js';
import type { SecretKey } from '../lib/crypto.js';
import { findDeviceByToken } from '../lib/local-agent-registry.js';
import { asyncRoute } from '../middleware/async-route.js';
import { MachineBundle } from '../services/MachineBundle.js';
import { MachineGitService } from '../services/MachineGitService.js';
import type { HeadscaleService } from '../services/HeadscaleService.js';
import type { MachineService } from '../services/MachineService.js';
import type { ProjectRepoService } from '../services/ProjectRepoService.js';
import { meshRouter } from '../routes/mesh.js';
import { localAgentsRouter } from '../routes/local-agents.js';
import { machinesRouter } from '../routes/machines.js';

export type Routes = { use(path: string, router: express.Router | express.RequestHandler): unknown; get(path: string, handler: express.RequestHandler): unknown };

export interface MachinesWiringDeps {
  tenant: Routes;
  db: Database;
  dataKey: SecretKey;
  publicUrl: string;
  repoRoot: string;
  machines: MachineService;
  headscale: HeadscaleService;
  projectRepos: ProjectRepoService;
}

export function wireMachines(deps: MachinesWiringDeps): void {
  const { tenant, db } = deps;
  tenant.use('/api/mesh', meshRouter({ headscaleService: deps.headscale, db }));
  tenant.use('/api/mesh/local-agents', localAgentsRouter({ machines: deps.machines }));
  const bundle = new MachineBundle(deps.repoRoot);
  const git = new MachineGitService({
    deviceFor: async (token) => findDeviceByToken(await db.getLocalAgentDevices(), token, deps.dataKey),
    remote: (ownerId, repo) => deps.projectRepos.gitRemote(ownerId, repo),
  });
  tenant.use('/api/machines', machinesRouter({ machines: deps.machines, bundle: () => bundle.path(), git }));
  tenant.get('/machine.sh', asyncRoute(async (_req, res) => {
    const installer = await fs.readFile(path.join(deps.repoRoot, 'scripts/machine/machine.sh'), 'utf8');
    res.type('text/x-shellscript').send(installer.replaceAll('__KOALA_URL__', deps.publicUrl));
  }));
}
