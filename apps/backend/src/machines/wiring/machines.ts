import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import type express from 'express';
import { installView } from '../../instances/index.js';
import { type Database, type LocalAgentDeviceMetadata, type SecretKey, asyncRoute, ringOf, temporalApiKey, type PayloadBlobs } from '../../platform/index.js';
import { checkWorkToken } from '../lib/work-tokens.js';
import { gatewayServerName } from '../lib/gateway-name.js';
import type { WorkTokenTrust } from './sockets.js';
import type { MachineAccounts } from '../services/MachineAccounts.js';
import type { KoalaInstalls } from '../services/KoalaInstalls.js';
import { accountMachinesRouter, type MachineCaller } from '../routes/account-machines.js';
import { MachineBundle } from '../services/MachineBundle.js';
import { MachineGitService } from '../services/MachineGitService.js';
import { MachineTemporalGateway } from '../services/MachineTemporalGateway.js';
import { MachineMetricsRelay, type MachineMetricsDeps } from '../services/MachineMetricsRelay.js';
import type { MachineService } from '../services/MachineService.js';
import type { ProjectRepoService } from '../../projects/index.js';
import { localAgentsRouter } from '../routes/local-agents.js';
import { machinesRouter } from '../routes/machines.js';
import { myMachinesRouter, type KoalaWhere } from '../routes/my-machines.js';

export type Routes = { use(path: string, router: express.Router | express.RequestHandler): unknown; get(path: string, handler: express.RequestHandler): unknown };

export interface MachinesWiringDeps {
  app: Routes;
  tenant: Routes;
  servesTenants: boolean;
  accounts?: MachineAccounts | undefined;
  installs?: KoalaInstalls | undefined;
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
  gateway?: { port: number; host: string; upstream: string; namespace: string; temporalKey: string; temporalCa?: Buffer | undefined; tls: MachineGatewayTls; payloadBlobs: PayloadBlobs } | undefined;
}

export interface MachineGatewayTls {
  cert: Buffer;
  key: Buffer;
  ca: string;
  serverName: string;
}

const readTls = (file: string, what: string): Buffer => {
  try {
    return fsSync.readFileSync(file);
  } catch (err) {
    throw new Error(`the machine gateway's ${what} could not be read at ${file}: ${(err as Error).message}; a machine reaches Temporal only over TLS, so the gateway does not start without it`);
  }
};

export function machineGatewayTls(place: { certPath: string; keyPath: string }, caPath: string): MachineGatewayTls {
  const cert = readTls(place.certPath, 'certificate');
  return { cert, key: readTls(place.keyPath, 'key'), ca: readTls(caPath, 'certificate authority').toString('utf8'), serverName: gatewayServerName(cert) };
}

export const machineBundle = (repoRoot: string, dataDir: string): MachineBundle => new MachineBundle(repoRoot, path.join(dataDir, 'machine-agent'));

export const deviceByWorkToken = (db: Pick<Database, 'machines'>, trust: WorkTokenTrust | undefined, now: () => Date = () => new Date()) =>
  async (token: string): Promise<LocalAgentDeviceMetadata | undefined> => {
    if (!trust) return undefined;
    const check = checkWorkToken(token, trust.keys, trust.audience, Math.floor(now().getTime() / 1000));
    if (!check.ok) return undefined;
    return (await db.machines.getLocalAgentDevices()).find((device) => device.id === check.claims.sub && device.ownerId === check.claims.owner);
  };

export function koalaOfOwner(db: Pick<Database, 'instances'>): (ownerId: string) => Promise<KoalaWhere | undefined> {
  return async (ownerId) => {
    const instance = (await db.instances.getInstances(ownerId))[0];
    return instance ? { machineId: instance.machineId, status: instance.status, ...(instance.install ? { install: installView(instance.install) } : {}) } : undefined;
  };
}

export function wireMachines(deps: MachinesWiringDeps): void {
  const { tenant, db } = deps;
  tenant.use('/api/mesh/local-agents', localAgentsRouter({ machines: deps.machines }));
  const { bundle } = deps;
  const git = new MachineGitService({
    deviceFor: deviceByWorkToken(db, deps.workTokens),
    remote: (ownerId, repo) => deps.projectRepos.gitRemote(ownerId, repo),
  });
  if (deps.gateway) {
    const { port, host, upstream, namespace, temporalKey, temporalCa, tls, payloadBlobs } = deps.gateway;
    const ring = ringOf(deps.dataKey);
    const gateway = new MachineTemporalGateway({
      upstream,
      upstreamKey: temporalApiKey(temporalKey, { subject: 'koala-machine-gateway', namespace, role: 'write' }),
      upstreamCa: temporalCa,
      namespace,
      tls: { cert: tls.cert, key: tls.key },
      keys: () => [ring.current, ...(ring.previous ?? [])],
      deviceOf: deviceByWorkToken(db, deps.workTokens),
      handed: (workflowId, deviceId) => payloadBlobs.handTo(workflowId, deviceId),
      log: (line) => console.log(line),
    });
    deps.machines.onForgotten((deviceId) => gateway.forget(deviceId));
    gateway.listen(port, host).then(
      (listening) => console.log(`[machine-gateway] machines reach Temporal through ${host}:${listening}`),
      (err: Error) => console.error(`[machine-gateway] could not listen on ${host}:${port}: ${err.message}`),
    );
  }
  const metrics = deps.servesTenants && deps.metricsWrite ? new MachineMetricsRelay({ clusters: () => db.infrastructure.getClusters(), write: deps.metricsWrite }) : undefined;
  deps.app.use('/api/machines', machinesRouter({ accounts: deps.accounts, installs: deps.installs, bundle, git: deps.servesTenants ? git : undefined, metrics }));
  if (deps.accounts) {
    const { accounts, instanceCaller } = deps;
    deps.app.use('/api/instances/machines', accountMachinesRouter({
      accounts,
      callerOf: async (req) => instanceCaller?.(String(req.headers['x-instance-id'] ?? ''), String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')),
    }));
    if (!deps.servesTenants) {
      deps.app.use('/api/my-machines', myMachinesRouter({ accounts, koalaOf: koalaOfOwner(db) }));
    }
    deps.app.get('/machine.sh', asyncRoute(async (_req, res) => {
      const installer = await fs.readFile(path.join(deps.repoRoot, 'scripts/machine/machine.sh'), 'utf8');
      res.type('text/x-shellscript').send(installer.replaceAll('__KOALA_URL__', deps.publicUrl));
    }));
  }
}
