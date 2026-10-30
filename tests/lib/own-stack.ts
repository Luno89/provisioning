import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { buildAppImage } from './gate-runs.js';
import { devFile, devTemporalCa } from './dev-temporal.js';
import { answers, envArgs, freePort, temporal, temporalContainer } from './split-stack.js';
import { dropSuiteDatabase, firstAdmin, suiteRoot, type FirstAdmin, type SuiteRoot } from './suite-root.js';

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
  exec: (process: OwnProcess, command: string) => string;
  restart: (process: OwnProcess) => Promise<void>;
  terminate: (workflowId: string, reason: string) => void;
  logs: (process: OwnProcess, lines?: number) => string;
  stop: () => Promise<void>;
}

const docker = (args: string[]): string => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function until(what: string, probe: () => Promise<true | undefined>, logs: () => string): Promise<void> {
  for (let tries = 1; ; tries += 1) {
    if (await probe().catch(() => undefined)) return;
    if (tries === 600) throw new Error(`${what} never happened\n${logs()}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export async function startOwnStack(suite: string, log: (line: string) => void = console.log): Promise<OwnStack> {
  dotenv.config({ path: devFile('apps/backend/.env'), quiet: true });
  const apiPort = await freePort();
  const gatewayPort = await freePort();
  const engineMetrics = await freePort();
  const root = suiteRoot(suite, await freePort());
  const namespace = root.queue;
  const url = `http://localhost:${apiPort}`;
  const image = buildAppImage(REPO, execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), (line) => log(`    ${line}`));
  const container: Record<OwnProcess, string> = { backend: `nw-${suite}-backend-${namespace}`, engine: `nw-${suite}-engine-${namespace}` };
  const started: string[] = [];
  const logs = (process: OwnProcess, lines = 80): string => {
    try {
      return execFileSync('docker', ['logs', '--tail', String(lines), container[process]], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      const failed = err as { stdout?: string; stderr?: string };
      return `${failed.stdout ?? ''}${failed.stderr ?? ''}`;
    }
  };
  const stop = async (): Promise<void> => {
    for (const name of started.reverse()) {
      try { docker(['rm', '-f', name]); } catch { /* gone */ }
    }
    await dropSuiteDatabase(root).catch(() => undefined);
    try { temporal(['namespace', 'delete', '--namespace', namespace, '--yes']); } catch { /* never made */ }
  };
  const env = {
    PORT: String(apiPort),
    PUBLIC_URL: url,
    APP_URL: url,
    MONGO_URI: root.mongoUri,
    ADMIN_SETUP_CODE: root.setupCode,
    TEMPORAL_NAMESPACE: namespace,
    MACHINE_GATEWAY_PORT: String(gatewayPort),
    MACHINE_TEMPORAL_ADDRESS: `localhost:${gatewayPort}`,
  };
  const run = (process: OwnProcess, command: string, extra: Record<string, string> = {}): void => {
    docker(['run', '-d', '--name', container[process], '--network', 'host', '--restart', 'on-failure', '--env-file', devFile('apps/backend/.env'), ...devTemporalCa(), ...envArgs({ ...env, ...extra }), image, command]);
    started.push(container[process]);
  };
  const backendAnswers = () => until('the backend answering', () => answers(`${url}/api/auth/sign-in`), () => logs('backend'));
  try {
    temporal(['namespace', 'create', '--namespace', namespace, '--retention', '24h']);
    run('backend', 'backend');
    run('engine', 'worker-engine', { HEALTH_PORT: '0', TEMPORAL_ENGINE_METRICS_PORT: String(engineMetrics) });
    await backendAnswers();
    const owner = await firstAdmin(url, root);
    return {
      url, api: `${url}/api`, apiPort, gatewayPort, root, owner, container,
      exec: (process, command) => docker(['exec', container[process], 'sh', '-c', command]),
      restart: async (process) => {
        docker(['restart', container[process]]);
        if (process === 'backend') await backendAnswers();
      },
      terminate: (workflowId, reason) => {
        docker(['exec', temporalContainer(), 'temporal', 'workflow', 'terminate', '--namespace', namespace, '--workflow-id', workflowId, '--reason', reason, '--address', '127.0.0.1:7236']);
      },
      logs,
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}
