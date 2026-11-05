import fs from 'fs/promises';
import path from 'path';
import type express from 'express';
import { type Database, type LocalAgentDeviceMetadata, type SecretKey, asyncRoute, ringOf, sharedPayloadBlobs, temporalApiKey } from '../../platform/index.js';
import { checkWorkToken } from '../lib/work-tokens.js';
import type { WorkTokenTrust } from './sockets.js';
import type { MachineAccounts } from '../services/MachineAccounts.js';
import { accountMachinesRouter, type MachineCaller } from '../routes/account-machines.js';
import { MachineBundle } from '../services/MachineBundle.js';
import { MachineGitService } from '../services/MachineGitService.js';
import { MachineTemporalGateway } from '../services/MachineTemporalGateway.js';
import { MachineMetricsRelay, type MachineMetricsDeps } from '../services/MachineMetricsRelay.js';
import type { MachineService } from '../services/MachineService.js';
import type { ProjectRepoService } from '../../projects/index.js';
import { localAgentsRouter } from '../routes/local-agents.js';
import { machinesRouter } from '../routes/machines.js';

export type Routes = { use(path: string, router: express.Router | express.RequestHandler): unknown; get(path: string, handler: express.RequestHandler): unknown };

export interface MachinesWiringDeps {
  app: Routes;
  tenant: Routes;
  servesTenants: boolean;
  accounts?: MachineAccounts | undefined;
  instanceCaller?: ((instanceId: string, credential: string) => Promise<MachineCaller | undefined>) | undefined;
  workTokens?: WorkTokenTrust | undefined;
  db: Database;
  dataKey: SecretKey;
  publicUrl: string;
  repoRoot: string;
  machines: MachineService;
  bundle: MachineBundle;
  projectRepos: ProjectRepoService;
  metricsWrite?: MachineMetricsDeps['write'] | undefined;
  gateway?: { port: number; host: string; upstream: string; namespace: string; temporalKey: string; temporalCa?: Buffer | undefined } | undefined;
}

export const machineBundle = (repoRoot: string): MachineBundle => new MachineBundle(repoRoot);

export const deviceByWorkToken = (db: Pick<Database, 'machines'>, trust: WorkTokenTrust | undefined, now: () => Date = () => new Date()) =>
  async (token: string): Promise<LocalAgentDeviceMetadata | undefined> => {
    if (!trust) return undefined;
    const check = checkWorkToken(token, trust.keys, trust.audience, Math.floor(now().getTime() / 1000));
    if (!check.ok) return undefined;
    return (await db.machines.getLocalAgentDevices()).find((device) => device.id === check.claims.sub && device.ownerId === check.claims.owner);
  };

export function wireMachines(deps: MachinesWiringDeps): void {
  const { tenant, db } = deps;
  tenant.use('/api/mesh/local-agents', localAgentsRouter({ machines: deps.machines }));
  const { bundle } = deps;
  const git = new MachineGitService({
    deviceFor: deviceByWorkToken(db, deps.workTokens),
    remote: (ownerId, repo) => deps.projectRepos.gitRemote(ownerId, repo),
  });
  if (deps.gateway) {
    const { port, host, upstream, namespace, temporalKey, temporalCa } = deps.gateway;
    const ring = ringOf(deps.dataKey);
    const gateway = new MachineTemporalGateway({
      upstream,
      upstreamKey: temporalApiKey(temporalKey, { subject: 'koala-machine-gateway', namespace, role: 'write' }),
      upstreamCa: temporalCa,
      namespace,
      keys: () => [ring.current, ...(ring.previous ?? [])],
      deviceOf: deviceByWorkToken(db, deps.workTokens),
      handed: (workflowId, deviceId) => sharedPayloadBlobs().handTo(workflowId, deviceId),
      log: (line) => console.log(line),
    });
    deps.machines.onForgotten((deviceId) => gateway.forget(deviceId));
    gateway.listen(port, host).then(
      (listening) => console.log(`[machine-gateway] machines reach Temporal through ${host}:${listening}`),
      (err: Error) => console.error(`[machine-gateway] could not listen on ${host}:${port}: ${err.message}`),
    );
  }
  const metrics = deps.servesTenants && deps.metricsWrite ? new MachineMetricsRelay({ clusters: () => db.infrastructure.getClusters(), write: deps.metricsWrite }) : undefined;
  deps.app.use('/api/machines', machinesRouter({ accounts: deps.accounts, bundle, git: deps.servesTenants ? git : undefined, metrics }));
  if (deps.accounts) {
    const { accounts, instanceCaller } = deps;
    deps.app.use('/api/instances/machines', accountMachinesRouter({
      accounts,
      callerOf: async (req) => instanceCaller?.(String(req.headers['x-instance-id'] ?? ''), String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')),
    }));
    deps.app.get('/machine.sh', asyncRoute(async (_req, res) => {
      const installer = await fs.readFile(path.join(deps.repoRoot, 'scripts/machine/machine.sh'), 'utf8');
      res.type('text/x-shellscript').send(installer.replaceAll('__KOALA_URL__', deps.publicUrl));
    }));
  }
}
