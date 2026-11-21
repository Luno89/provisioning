import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Database } from '../../platform/lib/db-interface.js';
import { InstanceService, type InstanceSettings } from '../services/InstanceService.js';
import { InstanceReach } from '../services/InstanceReach.js';
import { instancesRouter } from '../routes/instances.js';
import { KoalaInstalls, type InstallWorkflows } from '../../machines/services/KoalaInstalls.js';
import { testInstanceClients } from './placed-koala.js';

export const NO_MESH = { createPreAuthKey: async () => ({ key: 'k' }), removeNode: async () => undefined };

export function rootInstanceSettings(installs: () => KoalaInstalls): InstanceSettings {
  return {
    rootUrl: 'http://root.test', rootPublicKeys: () => ['PEM'], ...testInstanceClients, meshLoginServer: 'https://mesh.test', registry: '100.64.0.1:5001', imageTag: 'v1', domain: '',
    reach: new InstanceReach({ open: true, domain: '' }),
    installs: { setupHeard: (installId, report) => installs().setupHeard(installId, report) },
  };
}

export interface RootInstalls { instances: InstanceService; installs: KoalaInstalls; url: string }

export async function rootInstallsServed(db: Database, workflows: InstallWorkflows, closers: (() => Promise<void>)[]): Promise<RootInstalls> {
  let installs: KoalaInstalls | undefined;
  const instances = new InstanceService(db, rootInstanceSettings(() => installs!), NO_MESH);
  installs = new KoalaInstalls({
    devices: () => db.machines.getLocalAgentDevices(),
    places: () => instances,
    workflows,
    toMachines: { placeKoala: async () => false, stopKoala: () => false },
    toOwner: { installChanged: () => undefined },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/instances', instancesRouter({ instances, chart: async () => '/nowhere', operatorOnly: (_req: Request, _res: Response, next: NextFunction) => next() }));
  const server = http.createServer(app);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  closers.push(() => new Promise<void>((done) => { server.close(() => done()); }));
  return { instances, installs, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
