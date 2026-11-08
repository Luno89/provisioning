import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { portToHandOn } from '@koala/engine-core/testing/ports';
import { inject } from 'vitest';
import { testBucket } from '../../files/testing/real-minio.js';
import { unreachedPlatformServices } from './platform-services.js';

const BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TSX = resolve(BACKEND, '../../node_modules/.bin/tsx');

export interface LoopbackProcess {
  name: string;
  logs(lines?: number): string;
  stop(): Promise<void>;
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface LoopbackRole extends LoopbackProcess {
  url: string;
  port: number;
}

export interface RoleOptions {
  entry?: string | undefined;
  files?: Record<string, string> | undefined;
}

const NO_CLUSTER = `#!/bin/sh
[ "$1" = inspect ] && exit 0
echo "a process in the integration tier reaches no Docker and no cluster" >&2
exit 1
`;

const answering = async (url: string): Promise<boolean> => {
  const answer = await fetch(`${url}/api/auth/sign-in`, { redirect: 'manual' }).catch((err: Error) => err);
  return !(answer instanceof Error) && answer.status < 500;
};

const healthy = async (port: number): Promise<boolean> => {
  const answer = await fetch(`http://127.0.0.1:${port}/healthz`).catch((err: Error) => err);
  return !(answer instanceof Error) && answer.status === 200;
};

const MINIO_BUCKET = testBucket();

const minioEnv = (): Record<string, string> => {
  const minio = inject('minio');
  return { MINIO_ENDPOINT: `${minio.endPoint}:${minio.port}`, MINIO_ROOT_USER: minio.accessKey, MINIO_ROOT_PASSWORD: minio.secretKey, MINIO_BUCKET };
};

export async function startProcess(name: string, entry: string, env: Record<string, string>, ready: () => Promise<boolean>, files: Record<string, string> = {}): Promise<LoopbackProcess> {
  const home = await mkdtemp(join(tmpdir(), `koala-${name}-`));
  await mkdir(join(home, 'bin'));
  await writeFile(join(home, 'bin', 'docker'), NO_CLUSTER);
  await chmod(join(home, 'bin', 'docker'), 0o755);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(home, file)), { recursive: true });
    await writeFile(join(home, file), content, { mode: 0o600 });
  }
  const lines: string[] = [];
  let child: ChildProcess | undefined;
  const settings: NodeJS.ProcessEnv = {
    PATH: `${join(home, 'bin')}:${process.env.PATH ?? ''}`,
    HOME: home,
    NODE_ENV: 'development',
    JWT_SECRET: `${name}-loopback-test-secret`,
    ...minioEnv(),
    ...unreachedPlatformServices(),
    ...env,
  };
  const start = async (): Promise<void> => {
    child = spawn(TSX, [join(BACKEND, entry)], { cwd: home, env: settings, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = (chunk: Buffer) => { lines.push(...chunk.toString('utf8').split('\n').filter(Boolean)); if (lines.length > 2000) lines.splice(0, lines.length - 2000); };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const exited = new Promise<never>((_, fail) => child!.once('exit', (code) => fail(new Error(`${name} exited (${code}) before it answered:\n${lines.slice(-40).join('\n')}`))));
    const answered = (async () => { while (!await ready()) await new Promise((done) => setTimeout(done, 250)); })();
    await Promise.race([answered, exited]);
    child.removeAllListeners('exit');
  };
  const stop = async (): Promise<void> => {
    const running = child;
    child = undefined;
    if (!running || running.exitCode !== null) return;
    await new Promise<void>((done) => { running.once('exit', () => done()); running.kill('SIGTERM'); });
  };
  await start();
  return {
    name, start, stop,
    logs: (count = 60) => lines.slice(-count).join('\n'),
    close: async () => {
      await stop();
      await rm(home, { recursive: true, force: true });
    },
  };
}

export async function startRole(name: string, env: Record<string, string>, port?: number, options: RoleOptions = {}): Promise<LoopbackRole> {
  const at = port ?? await portToHandOn();
  const url = `http://localhost:${at}`;
  const started = options.entry
    ? await startProcess(name, options.entry, { PORT: String(at), PUBLIC_URL: url, APP_URL: url, HEALTH_PORT: String(at), GITEA_REACHES_KOALA_AT: url, ...env }, () => healthy(at), options.files)
    : await startProcess(name, 'src/index.ts', { PORT: String(at), PUBLIC_URL: url, APP_URL: url, GITEA_REACHES_KOALA_AT: url, ...env }, () => answering(url), options.files);
  return { ...started, url, port: at };
}

export async function startWorker(name: string, entry: string, env: Record<string, string>): Promise<LoopbackProcess> {
  const port = await portToHandOn();
  return startProcess(name, entry, { HEALTH_PORT: String(port), ...env }, () => healthy(port));
}
