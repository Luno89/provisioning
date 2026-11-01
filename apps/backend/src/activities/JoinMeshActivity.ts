import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ignore } from '@koala/engine-core/failures';
import { messageOf, waitingOn } from './failure-reasons.js';

const execFileAsync = promisify(execFile);

export interface JoinMeshArgs {
  physicalName: string;
  host: string;
  port?: number;
  username: string;
  privateKey: string;
  loginServer: string;
  preAuthKey: string;
}

export interface JoinMeshResult {
  meshIp: string;
}

function sshPrefix(username: string): string {
  return username === 'root' ? '' : 'sudo -n ';
}

async function runSsh(host: string, port: number, username: string, keyPath: string, command: string): Promise<string> {
  const { stdout } = await execFileAsync('ssh', [
    '-i', keyPath,
    '-p', String(port),
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=15',
    '-o', 'BatchMode=yes',
    `${username}@${host}`,
    command,
  ], { maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

function isMeshIp(ip: string): boolean {
  const m = ip.trim().match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 100 && b >= 64 && b <= 127;
}

export async function JoinMeshActivity(args: JoinMeshArgs): Promise<JoinMeshResult> {
  if (/localhost|127\.0\.0\.1/.test(args.loginServer)) {
    throw new Error(
      `Headscale login server is ${args.loginServer} — a remote host cannot reach that. Set a public HEADSCALE_LOGIN_SERVER before enabling mesh join.`,
    );
  }

  const port = args.port ?? 22;
  const keyPath = path.join(os.tmpdir(), `mesh-key-${args.physicalName}-${Date.now()}`);
  await fs.writeFile(keyPath, args.privateKey.endsWith('\n') ? args.privateKey : `${args.privateKey}\n`, { mode: 0o600 });

  try {
    const prefix = sshPrefix(args.username);
    const ssh = (cmd: string) => runSsh(args.host, port, args.username, keyPath, cmd);

    const existing = await ssh(`${prefix}tailscale ip -4 2>/dev/null || true`).catch(ignore('an ssh that fails here fails again, with its reason, at the steps below')) ?? '';
    if (isMeshIp(existing)) {
      return { meshIp: existing.trim().split('\n')[0]!.trim() };
    }

    const installed = await ssh('command -v tailscale').then(() => true, ignore('tailscale missing is the answer, and an ssh that cannot run fails again, with its reason, at the install'));
    if (!installed) {
      await ssh(`${prefix}sh -c 'curl -fsSL https://tailscale.com/install.sh | sh'`);
    }

    await ssh(
      `${prefix}tailscale up --login-server=${args.loginServer} --authkey=${args.preAuthKey} --hostname=${args.physicalName} --accept-routes=false`,
    );

    let meshIp = '';
    const waiting = waitingOn(`${args.host}'s mesh address`);
    for (let attempt = 0; attempt < 20; attempt++) {
      const out = await ssh(`${prefix}tailscale ip -4 2>/dev/null || true`).catch((err: unknown) => { waiting(err); return ''; });
      const candidate = out.trim().split('\n')[0]?.trim() ?? '';
      if (isMeshIp(candidate)) {
        meshIp = candidate;
        break;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }

    if (!meshIp) {
      throw new Error(
        `Host joined the mesh but never reported a 100.64.0.0/10 address (last seen: "${(await ssh(`${prefix}tailscale status 2>&1 | head -3 || true`).catch((err: unknown) => `unavailable: ${messageOf(err)}`)).trim()}")`,
      );
    }

    return { meshIp };
  } finally {
    await fs.rm(keyPath, { force: true });
  }
}
