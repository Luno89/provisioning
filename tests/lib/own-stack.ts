import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { buildAppImage } from './gate-runs.js';
import { devFile, devGatewayTls, devTemporalCa } from './dev-temporal.js';
import { answers, envArgs, minioReady, minioRun, temporal, temporalCli } from './split-stack.js';
import { DEV_TEMPORAL_ADDRESS, dropSuiteDatabase, firstAdmin, suiteRoot, type FirstAdmin, type SuiteRoot } from './suite-root.js';
import { unreachedPlatformServices } from '../../apps/backend/src/platform/testing/platform-services.js';
import { portToHandOn } from '@koala/engine-core/testing/ports';
import { until } from './until.js';
import { containerNotRunning, hostContainers } from './dead-states.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

export type OwnProcess = 'backend' | 'engine';

export interface OwnStack {
  url: string;
  api: string;
  apiPort: number;
  gatewayPort: number;
  root: SuiteRoot;
  owner: FirstAdmin;
  container: Record<OwnProcess, string>;
  exec: (process: OwnProcess, command: string) => Promise<string>;
  restart: (process: OwnProcess) => Promise<void>;
  terminate: (workflowId: string, reason: string) => Promise<void>;
  logs: (process: OwnProcess, lines?: number) => Promise<string>;
  stop: () => Promise<void>;
}

export async function startOwnStack(suite: string, log: (line: string) => void = console.log): Promise<OwnStack> {
  dotenv.config({ path: devFile('apps/backend/.env'), quiet: true });
  const apiPort = await portToHandOn();
  const gatewayPort = await portToHandOn();
  const engineMetrics = await portToHandOn();
  const filesPort = await portToHandOn();
  const root = suiteRoot(suite, await portToHandOn());
  const namespace = root.namespace;
  const url = `http://localhost:${apiPort}`;
  const image = await buildAppImage(REPO, execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), (line) => log(`    ${line}`));
  const container: Record<OwnProcess | 'files', string> = { backend: `nw-${suite}-backend-${namespace}`, engine: `nw-${suite}-engine-${namespace}`, files: `nw-${suite}-files-${namespace}` };
  const started: string[] = [];
  const logs = (process: OwnProcess | 'files', lines = 80): Promise<string> => hostContainers.logs(container[process], lines).catch((failure: Error) => failure.message);
  const stop = async (): Promise<void> => {
    for (const name of started.reverse()) {
      await hostContainers.remove(name);
    }
    await dropSuiteDatabase(root).catch(() => undefined);
    try { await temporal(['namespace', 'delete', '--namespace', namespace, '--yes']); } catch { /* never made */ }
  };
  const files = minioRun(filesPort);
  const env = {
    ...files.env,
    PORT: String(apiPort),
    PUBLIC_URL: url,
    APP_URL: url,
    TRUST_PROXY: 'loopback',
    MONGO_URI: root.mongoUri,
    ADMIN_SETUP_CODE: root.setupCode,
    TEMPORAL_CONNECTION_ADDRESS: DEV_TEMPORAL_ADDRESS,
    TEMPORAL_NAMESPACE: namespace,
    TERRAFORM_STATE: 'local',
    DATA_DIR: '/app/apps/backend/data',
    MACHINE_GATEWAY_PORT: String(gatewayPort),
    MACHINE_TEMPORAL_ADDRESS: `localhost:${gatewayPort}`,
    ...unreachedPlatformServices(url),
  };
  const run = async (process: OwnProcess, command: string, extra: Record<string, string> = {}): Promise<void> => {
    await hostContainers.run(container[process], ['--network', 'host', '--restart', 'on-failure', '--env-file', devFile('apps/backend/.env'), ...devTemporalCa(), ...(process === 'backend' ? devGatewayTls() : []), ...envArgs({ ...env, ...extra }), image, command]);
    started.push(container[process]);
  };
  const backendAnswers = () => until('the backend answering', () => answers(`${url}/api/auth/sign-in`), () => containerNotRunning(container.backend));
  try {
    await temporal(['namespace', 'create', '--namespace', namespace, '--retention', '24h']);
    await hostContainers.run(container.files, files.args);
    started.push(container.files);
    await until('its MinIO being ready', () => minioReady(filesPort), () => containerNotRunning(container.files));
    await run('backend', 'backend');
    await run('engine', 'worker-engine', { HEALTH_PORT: '0', TEMPORAL_ENGINE_METRICS_PORT: String(engineMetrics), POD_NAME: container.engine });
    await backendAnswers();
    const owner = await firstAdmin(url, root);
    return {
      url, api: `${url}/api`, apiPort, gatewayPort, root, owner, container,
      exec: (process, command) => hostContainers.exec(container[process], ['sh', '-c', command]),
      restart: async (process) => {
        await hostContainers.restart(container[process]);
        if (process === 'backend') await backendAnswers();
      },
      terminate: async (workflowId, reason) => {
        await temporalCli(['workflow', 'terminate', '--namespace', namespace, '--workflow-id', workflowId, '--reason', reason]);
      },
      logs,
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}
