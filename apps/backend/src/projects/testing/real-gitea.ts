import crypto from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ignore } from '@koala/engine-core/failures';
import { freePort } from '../../platform/testing/roles-on-loopback.js';

const run = promisify(execFile);
const ADMIN = 'provisioning-bot';
const CI_TOOLS = fileURLToPath(new URL('../../../../../scripts/ci-tools.sh', import.meta.url));

export interface RealGitea {
  url: string;
  adminPassword: string;
  unhandled: string[];
  logs(): string;
  close(): Promise<void>;
}

let binary: Promise<string> | undefined;

export function giteaBinary(): Promise<string> {
  binary ??= run('bash', [CI_TOOLS, 'gitea-server'], { env: process.env }).then(({ stdout }) => stdout.trim());
  return binary;
}

const appIni = (work: string, port: number, user: string): string => `
APP_NAME = Koala test Gitea
RUN_MODE = prod
RUN_USER = ${user}
WORK_PATH = ${work}

[server]
PROTOCOL = http
HTTP_ADDR = 127.0.0.1
HTTP_PORT = ${port}
DOMAIN = 127.0.0.1
ROOT_URL = http://127.0.0.1:${port}/
APP_DATA_PATH = ${work}/data
DISABLE_SSH = true
START_SSH_SERVER = false
OFFLINE_MODE = true
LFS_START_SERVER = false

[database]
DB_TYPE = sqlite3
PATH = ${work}/data/gitea.db

[repository]
ROOT = ${work}/repositories
DEFAULT_BRANCH = main

[security]
INSTALL_LOCK = true
SECRET_KEY = ${crypto.randomBytes(32).toString('hex')}
INTERNAL_TOKEN = ${crypto.randomBytes(48).toString('base64url')}
PASSWORD_COMPLEXITY = off
MIN_PASSWORD_LENGTH = 8
ALLOWED_HOST_LIST = loopback,private

[oauth2]
JWT_SECRET = ${crypto.randomBytes(32).toString('base64url')}

[service]
REQUIRE_SIGNIN_VIEW = true
DEFAULT_USER_VISIBILITY = private
DISABLE_REGISTRATION = true

[queue]
TYPE = channel

[packages]
ENABLED = true

[mailer]
ENABLED = false

[session]
PROVIDER = memory

[cache]
ADAPTER = memory

[cron]
ENABLED = false

[log]
MODE = console
LEVEL = Warn
ROOT_PATH = ${work}/log
`;

async function answers(url: string): Promise<boolean> {
  const answer = await fetch(`${url}/api/healthz`).catch(ignore('Gitea refuses connections until it listens, which is what waiting for it looks like'));
  return answer?.ok === true;
}

export async function startRealGitea(): Promise<RealGitea> {
  const gitea = await giteaBinary();
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'koala-real-gitea-'));
  const port = await freePort();
  const config = path.join(work, 'app.ini');
  const adminPassword = crypto.randomBytes(18).toString('base64url');
  const env = { PATH: process.env.PATH, HOME: work, USER: os.userInfo().username, GITEA_WORK_DIR: work };
  await fs.writeFile(config, appIni(work, port, os.userInfo().username));
  const cli = (args: string[]) => run(gitea, [...args, '--config', config, '--work-path', work], { env, cwd: work });
  await cli(['migrate']);
  await cli(['admin', 'user', 'create', '--username', ADMIN, '--password', adminPassword, '--email', 'bot@provisioning.local', '--admin', '--must-change-password=false']);
  const said: string[] = [];
  const server: ChildProcess = spawn(gitea, ['web', '--config', config, '--work-path', work], { env, cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
  const keep = (chunk: Buffer) => { said.push(chunk.toString('utf8')); if (said.length > 400) said.splice(0, said.length - 400); };
  server.stdout!.on('data', keep);
  server.stderr!.on('data', keep);
  const exited = new Promise<void>((done) => server.once('exit', () => done()));
  const url = `http://127.0.0.1:${port}`;
  const close = async () => {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM');
      await exited;
    }
    await fs.rm(work, { recursive: true, force: true });
  };
  let gone = false;
  void exited.then(() => { gone = true; });
  while (!(await answers(url))) {
    if (gone) {
      await close();
      throw new Error(`Gitea stopped before it answered:\n${said.join('')}`);
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  return { url, adminPassword, unhandled: [], logs: () => said.join(''), close };
}
