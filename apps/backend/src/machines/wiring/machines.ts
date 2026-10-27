import fs from 'fs/promises';
import path from 'path';
import type express from 'express';
import { type Database, type SecretKey, asyncRoute, ringOf, sharedPayloadBlobs, temporalApiKey } from '../../platform/index.js';
import { findDeviceByToken } from '../lib/local-agent-registry.js';
import { MachineBundle } from '../services/MachineBundle.js';
import { MachineGitService } from '../services/MachineGitService.js';
import { MachineTemporalGateway } from '../services/MachineTemporalGateway.js';
import { type HeadscaleService, meshRouter } from '../../infrastructure/index.js';
import type { MachineService } from '../services/MachineService.js';
import type { ProjectRepoService } from '../../projects/index.js';
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
  gateway?: { port: number; host: string; upstream: string; namespace: string; temporalKey: string } | undefined;
}

export function wireMachines(deps: MachinesWiringDeps): void {
  const { tenant, db } = deps;
  tenant.use('/api/mesh', meshRouter({ headscaleService: deps.headscale, db }));
  tenant.use('/api/mesh/local-agents', localAgentsRouter({ machines: deps.machines }));
  const bundle = new MachineBundle(deps.repoRoot);
  const git = new MachineGitService({
    deviceFor: async (token) => findDeviceByToken(await db.machines.getLocalAgentDevices(), token, deps.dataKey),
    remote: (ownerId, repo) => deps.projectRepos.gitRemote(ownerId, repo),
  });
  if (deps.gateway) {
    const { port, host, upstream, namespace, temporalKey } = deps.gateway;
    const ring = ringOf(deps.dataKey);
    const gateway = new MachineTemporalGateway({
      upstream,
      upstreamKey: temporalApiKey(temporalKey, { subject: 'koala-machine-gateway', namespace, role: 'write' }),
      namespace,
      keys: () => [ring.current, ...(ring.previous ?? [])],
      deviceOf: async (token) => findDeviceByToken(await db.machines.getLocalAgentDevices(), token, deps.dataKey),
      handed: (workflowId, deviceId) => sharedPayloadBlobs().handTo(workflowId, deviceId),
      log: (line) => console.log(line),
    });
    gateway.listen(port, host).then(
      (listening) => console.log(`[machine-gateway] machines reach Temporal through ${host}:${listening}`),
      (err: Error) => console.error(`[machine-gateway] could not listen on ${host}:${port}: ${err.message}`),
    );
  }
  tenant.use('/api/machines', machinesRouter({ machines: deps.machines, bundle: () => bundle.path(), git }));
  tenant.get('/machine.sh', asyncRoute(async (_req, res) => {
    const installer = await fs.readFile(path.join(deps.repoRoot, 'scripts/machine/machine.sh'), 'utf8');
    res.type('text/x-shellscript').send(installer.replaceAll('__KOALA_URL__', deps.publicUrl));
  }));
}
