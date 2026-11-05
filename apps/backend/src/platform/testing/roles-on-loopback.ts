import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TSX = resolve(BACKEND, '../../node_modules/.bin/tsx');

export async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? done(address.port) : fail(new Error('no port'))));
    });
  });
}

export interface LoopbackRole {
  name: string;
  url: string;
  port: number;
  logs(lines?: number): string;
  stop(): Promise<void>;
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface RoleProcess {
  entry?: string | undefined;
  answersAt?: string | undefined;
}

const answering = async (url: string, path: string): Promise<boolean> => {
  const answer = await fetch(`${url}${path}`, { redirect: 'manual' }).catch((err: Error) => err);
  return !(answer instanceof Error) && answer.status < 500;
};

export async function startRole(name: string, env: Record<string, string>, port?: number, launch: RoleProcess = {}): Promise<LoopbackRole> {
  const at = port ?? await freePort();
  const home = await mkdtemp(join(tmpdir(), `koala-${name}-`));
  const url = `http://localhost:${at}`;
  const lines: string[] = [];
  let child: ChildProcess | undefined;
  const settings: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    NODE_ENV: 'development',
    JWT_SECRET: `${name}-loopback-test-secret`,
    PORT: String(at),
    PUBLIC_URL: url,
    APP_URL: url,
    ...env,
  };
  const start = async (): Promise<void> => {
    child = spawn(TSX, [join(BACKEND, launch.entry ?? 'src/index.ts')], { cwd: home, env: settings, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = (chunk: Buffer) => { lines.push(...chunk.toString('utf8').split('\n').filter(Boolean)); if (lines.length > 2000) lines.splice(0, lines.length - 2000); };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const exited = new Promise<never>((_, fail) => child!.once('exit', (code) => fail(new Error(`${name} exited (${code}) before it answered:\n${lines.slice(-40).join('\n')}`))));
    const ready = (async () => { while (!await answering(url, launch.answersAt ?? '/api/auth/sign-in')) await new Promise((done) => setTimeout(done, 250)); })();
    await Promise.race([ready, exited]);
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
    name, url, port: at, start, stop,
    logs: (count = 60) => lines.slice(-count).join('\n'),
    close: async () => {
      await stop();
      await rm(home, { recursive: true, force: true });
    },
  };
}
