import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const execFileAsync = promisify(execFile);

const DO_API = 'https://api.digitalocean.com/v2';

const DO_SSH_USERNAME = 'root';

export interface ProvisionDigitalOceanVmArgs {
  name: string;
  doToken: string;
  logFile: string;
  size?: string;
  region?: string;
  image?: string;
  sshPrivateKey?: string;
  sshPublicKey?: string;
}

export interface ProvisionDigitalOceanVmResult {
  host: string;
  serverId: string;
  privateKey: string;
  username: string;
}

async function doApi(token: string, pathname: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${DO_API}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 204) return {};
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) {
    throw new Error(`${pathname} → ${body?.message ?? `HTTP ${res.status}`}`);
  }
  return body;
}

async function generateSshKeypairLocal(name: string) {
  const keyPath = path.join(os.tmpdir(), `do-key-${name}-${Date.now()}`);
  await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-C', `provisioning-${name}`]);
  const [privateKey, publicKey] = await Promise.all([
    fs.readFile(keyPath, 'utf-8'),
    fs.readFile(`${keyPath}.pub`, 'utf-8'),
  ]);
  return {
    privateKey,
    publicKey: publicKey.trim(),
    cleanup: async () => {
      await fs.rm(keyPath, { force: true });
      await fs.rm(`${keyPath}.pub`, { force: true });
    },
  };
}

async function ensureSshKey(token: string, name: string, publicKey: string): Promise<number> {
  const keyName = `provisioning-${name}`;
  const existing = await doApi(token, '/account/keys?per_page=200');
  const match = (existing?.ssh_keys ?? []).find((k: any) => k?.name === keyName);
  if (match?.id) return Number(match.id);

  const created = await doApi(token, '/account/keys', {
    method: 'POST',
    body: JSON.stringify({ name: keyName, public_key: publicKey }),
  });
  return Number(created?.ssh_key?.id);
}

async function findExistingDroplet(token: string, name: string): Promise<any | undefined> {
  const res = await doApi(token, `/droplets?per_page=200&name=${encodeURIComponent(name)}`);
  return (res?.droplets ?? []).find((d: any) => d?.name === name);
}

function publicIpv4(droplet: any): string | undefined {
  return (droplet?.networks?.v4 ?? []).find((n: any) => n?.type === 'public')?.ip_address;
}

async function waitForSsh(host: string, privateKeyPath: string, attempts = 60): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await execFileAsync('ssh', [
        '-i', privateKeyPath,
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'ConnectTimeout=10',
        '-o', 'BatchMode=yes',
        `${DO_SSH_USERNAME}@${host}`,
        'true',
      ]);
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw new Error(`Droplet ${host} never became SSH-reachable: ${(lastErr as Error)?.message ?? 'unknown error'}`);
}

export async function ProvisionDigitalOceanVmActivity(
  args: ProvisionDigitalOceanVmArgs,
): Promise<ProvisionDigitalOceanVmResult> {
  const log = async (msg: string) => {
    await fs.appendFile(args.logFile, `[digitalocean] ${msg}\n`).catch(() => {});
  };

  const supplied = args.sshPrivateKey && args.sshPublicKey
    ? { privateKey: args.sshPrivateKey, publicKey: args.sshPublicKey, cleanup: async () => {} }
    : undefined;
  const { privateKey, publicKey, cleanup } = supplied ?? await generateSshKeypairLocal(args.name);

  const keyPath = path.join(os.tmpdir(), `do-provision-${args.name}-${Date.now()}`);

  try {
    let droplet = await findExistingDroplet(args.doToken, args.name);
    if (droplet) {
      await log(`Reusing existing droplet ${droplet.id} (a previous attempt created it)`);
    } else {
      const keyId = await ensureSshKey(args.doToken, args.name, publicKey);
      const created = await doApi(args.doToken, '/droplets', {
        method: 'POST',
        body: JSON.stringify({
          name: args.name,
          region: args.region || 'nyc3',
          size: args.size || 's-4vcpu-8gb',
          image: args.image || 'ubuntu-24-04-x64',
          ssh_keys: [keyId],
          tags: ['nowrinkles', `cluster-${args.name}`],
        }),
      });
      droplet = created?.droplet;
      if (!droplet?.id) throw new Error('DigitalOcean did not return a droplet id');
      await log(`Created droplet ${droplet.id}`);
    }

    let host = publicIpv4(droplet);
    for (let i = 0; i < 60 && !host; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const refreshed = await doApi(args.doToken, `/droplets/${droplet.id}`);
      droplet = refreshed?.droplet ?? droplet;
      host = publicIpv4(droplet);
    }
    if (!host) throw new Error(`Droplet ${droplet.id} never reported a public IPv4 address`);
    await log(`Droplet ${droplet.id} is ${host}, waiting for SSH`);

    await fs.writeFile(keyPath, privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`, { mode: 0o600 });
    await waitForSsh(host, keyPath);
    await log(`SSH is up on ${host}`);

    return { host, serverId: String(droplet.id), privateKey, username: DO_SSH_USERNAME };
  } finally {
    await fs.rm(keyPath, { force: true }).catch(() => {});
    await cleanup();
  }
}

export interface DestroyDigitalOceanVmArgs {
  name: string;
  doToken: string;
  logFile: string;
  serverId?: string;
}

export async function DestroyDigitalOceanVmActivity(
  args: DestroyDigitalOceanVmArgs,
): Promise<{ verified: boolean; msg: string }> {
  const log = async (msg: string) => {
    await fs.appendFile(args.logFile, `[digitalocean] ${msg}\n`).catch(() => {});
  };

  let serverId = args.serverId;
  if (!serverId) {
    const found = await findExistingDroplet(args.doToken, args.name);
    serverId = found?.id ? String(found.id) : undefined;
  }
  if (!serverId) {
    return { verified: true, msg: `No droplet named ${args.name} exists — nothing to delete` };
  }

  await doApi(args.doToken, `/droplets/${serverId}`, { method: 'DELETE' }).catch(async (err) => {
    if (!/404|not found/i.test(String(err?.message))) throw err;
    await log(`Droplet ${serverId} was already absent`);
  });

  for (let i = 0; i < 12; i++) {
    try {
      await doApi(args.doToken, `/droplets/${serverId}`);
    } catch (err: any) {
      if (/404|not found/i.test(String(err?.message))) {
        return { verified: true, msg: `DigitalOcean droplet ${serverId} confirmed deleted` };
      }
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return {
    verified: false,
    msg: `DigitalOcean droplet ${serverId} still resolves after delete — check the project manually`,
  };
}
