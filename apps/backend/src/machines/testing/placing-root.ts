import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { Server as SocketServer } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { KOALA_INSTALL_CHANGED } from '@koala/engine-core/koala-install';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { roleFromEnv } from '../../platform/lib/platform-role.js';
import { generateIdentityKey } from '../../instances/lib/identity-token.js';
import { InstanceService } from '../../instances/services/InstanceService.js';
import { NO_MESH, rootInstanceSettings } from '../../instances/testing/root-installs.js';
import { instancesRouter } from '../../instances/routes/instances.js';
import { koalaInstallActivities } from '../../activities/KoalaInstallActivities.js';
import { bundled, temporalTestEnvironment, type TestTemporal } from '../../workflows/testing/temporal-test-env.js';
import { ProjectRepoService } from '../../projects/services/ProjectRepoService.js';
import type { GiteaService } from '../../projects/services/GiteaService.js';
import { userRoom } from '../../engine-host/temporal/stream-worker.js';
import type { MachineAccounts } from '../services/MachineAccounts.js';
import type { InstallWorkflows, KoalaInstalls } from '../services/KoalaInstalls.js';
import { machinesRouter } from '../routes/machines.js';
import { machineSides, temporalInstallWorkflows, type MachineSides } from '../wiring/sides.js';
import { until } from './wiring-world.js';
import { testWorker } from '../../workflows/testing/test-worker.js';

export interface InstallWorkflowWorld {
  env: TestTemporal;
  workflows(down?: () => boolean): InstallWorkflows;
  close(): Promise<void>;
}

export async function installWorkflowWorld(db: () => MongoDB): Promise<InstallWorkflowWorld> {
  const env = await temporalTestEnvironment();
  const taskQueue = `koala-install-${Math.random().toString(36).slice(2, 8)}`;
  const worker = await testWorker(env, {
    namespace: env.namespace ?? 'default', taskQueue,
    workflowBundle: await bundled(resolve(import.meta.dirname, '../../workflows/KoalaInstallWorkflow.ts')),
    activities: koalaInstallActivities({ db: async () => ({ db: db(), close: async () => undefined }), now: () => new Date() }),
  });
  const running = worker.run();
  return {
    env,
    workflows: (down = () => false) => temporalInstallWorkflows(async () => {
      if (down()) throw new Error('Temporal is not answering');
      return env.client;
    }, taskQueue),
    close: async () => {
      worker.shutdown();
      await running;
      await env.teardown();
    },
  };
}

export interface PlacingRoot {
  url: string;
  accounts: MachineAccounts;
  installs: KoalaInstalls;
  instances: InstanceService;
  sides: MachineSides;
  told: unknown[];
  close(): Promise<void>;
}

export interface PlacingRootOptions {
  db: MongoDB;
  workflows: InstallWorkflows;
  rootUrlIsServed?: boolean;
  chart?: string;
}

export async function placingRoot(options: PlacingRootOptions): Promise<PlacingRoot> {
  const { db } = options;
  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const io = new SocketServer(server);
  io.on('connection', (socket) => { void socket.join(userRoom('bo')); });
  let sides: MachineSides | undefined;
  const settings = rootInstanceSettings(() => sides!.installs!);
  const instances = new InstanceService(db, {
    ...settings,
    ...(options.rootUrlIsServed ? { rootUrl: url } : {}),
  }, NO_MESH, () => new Date(), () => undefined);
  sides = machineSides({
    role: roleFromEnv({ ROLE: 'root', ROOT_IDENTITY_KEY: generateIdentityKey() }),
    db, io, dataKey: 'koala-placement-key', publicUrl: 'http://root.test', meshLoginServer: 'https://mesh.test',
    mesh: { createPreAuthKey: async () => ({ key: 'k' }), removeNode: async () => undefined },
    devices: { status: () => ({ online: false }), tell: () => true, ask: async () => undefined as never, drop: () => undefined },
    projects: new ProjectRepoService(db, {} as GiteaService, 'koala-placement-key'),
    instances: () => ({ places: instances }),
    installWorkflows: options.workflows,
  });
  const accounts = sides.accounts!;
  const installs = sides.installs!;
  app.use('/api/machines', machinesRouter({ accounts, installs, bundle: { path: async () => '/nowhere', sha256: async () => 'ab'.repeat(32) } }));
  const chart = options.chart ?? '/nowhere';
  app.use('/api/instances', instancesRouter({ instances, chart: async () => chart, operatorOnly: (_req: Request, _res: Response, next: NextFunction) => next() }));
  await sides.watched!.ready;
  const told: unknown[] = [];
  const browser: ClientSocket = connect(url, { transports: ['websocket'], reconnection: false, forceNew: true });
  browser.on(KOALA_INSTALL_CHANGED, (said: unknown) => told.push(said));
  await until(async () => (browser.connected ? true : undefined));
  return {
    url, accounts, installs, instances, sides, told,
    close: async () => {
      browser.close();
      await sides!.watched!.close();
      await io.close();
      await new Promise<void>((done) => { server.close(() => done()); });
    },
  };
}
