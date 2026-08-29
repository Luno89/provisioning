import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { InfrastructureService } from '../services/InfrastructureService.js';

const execFileAsync = promisify(execFile);

export interface ProvisionHetznerVmArgs {
  name: string;
  hcloudToken: string;
  logFile: string;
  serverType?: string;
  location?: string;
  image?: string;
  sshPrivateKey?: string;
  sshPublicKey?: string;
}

export interface ProvisionHetznerVmResult {
  host: string;
  serverId: string;
  privateKey: string;
  username: string;
}

const HETZNER_SSH_USERNAME = 'root';

export function hetznerVmStackName(clusterName: string): string {
  return `vm-${clusterName}`;
}

async function generateSshKeypairLocal(name: string): Promise<{ privateKey: string; publicKey: string; cleanup: () => Promise<void> }> {
  const keyPath = path.join(os.tmpdir(), `hetzner-key-${name}-${Date.now()}`);
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
        `${HETZNER_SSH_USERNAME}@${host}`,
        'true',
      ]);
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw new Error(`VM ${host} never became SSH-reachable: ${(lastErr as Error)?.message ?? 'unknown error'}`);
}

export async function ProvisionHetznerVmActivity(
  args: ProvisionHetznerVmArgs,
): Promise<ProvisionHetznerVmResult> {
  const infra = new InfrastructureService();
  const stackName = hetznerVmStackName(args.name);
  const outputsFile = path.join(os.tmpdir(), `hetzner-outputs-${args.name}-${Date.now()}.json`);

  const supplied = args.sshPrivateKey && args.sshPublicKey
    ? { privateKey: args.sshPrivateKey, publicKey: args.sshPublicKey, cleanup: async () => {} }
    : undefined;
  const { privateKey, publicKey, cleanup } = supplied ?? await generateSshKeypairLocal(args.name);

  try {
    await infra.deploy(stackName, {
      logFile: args.logFile,
      outputsFile,
      env: {
        STACK_TYPE: 'vm',
        CLUSTER_NAME: args.name,
        HCLOUD_TOKEN: args.hcloudToken,
        VM_SSH_PUBLIC_KEY: publicKey,
        ...(args.serverType ? { HETZNER_SERVER_TYPE: args.serverType } : {}),
        ...(args.location ? { HETZNER_LOCATION: args.location } : {}),
        ...(args.image ? { HETZNER_IMAGE: args.image } : {}),
      },
      timeout: 15 * 60 * 1000,
    });

    const raw = await fs.readFile(outputsFile, 'utf-8');
    const outputs = JSON.parse(raw)?.[stackName] ?? {};
    const host = outputs.ipv4_address;
    const serverId = outputs.server_id;

    if (!host) {
      throw new Error(`Hetzner VM stack ${stackName} produced no ipv4_address output`);
    }

    const keyPath = path.join(os.tmpdir(), `hetzner-wait-${args.name}-${Date.now()}`);
    await fs.writeFile(keyPath, privateKey, { mode: 0o600 });
    try {
      await waitForSsh(host, keyPath);
    } finally {
      await fs.rm(keyPath, { force: true });
    }

    const result = { host, serverId: String(serverId ?? ''), privateKey, username: HETZNER_SSH_USERNAME };
    await cleanup();
    return result;
  } finally {
    await fs.rm(outputsFile, { force: true });
  }
}

export interface DestroyHetznerVmArgs {
  name: string;
  hcloudToken: string;
  logFile: string;
  serverId?: string;
}

export async function DestroyHetznerVmActivity(args: DestroyHetznerVmArgs): Promise<{ verified: boolean; msg: string }> {
  const infra = new InfrastructureService();
  const stackName = hetznerVmStackName(args.name);

  await infra.destroy(stackName, {
    logFile: args.logFile,
    env: {
      STACK_TYPE: 'vm',
      CLUSTER_NAME: args.name,
      HCLOUD_TOKEN: args.hcloudToken,
      VM_SSH_PUBLIC_KEY: 'ssh-ed25519 AAAA placeholder',
    },
    timeout: 15 * 60 * 1000,
  });

  if (!args.serverId) {
    return { verified: false, msg: `Destroyed ${stackName} (no serverId recorded, so no API verification)` };
  }

  const res = await fetch(`https://api.hetzner.cloud/v1/servers/${args.serverId}`, {
    headers: { Authorization: `Bearer ${args.hcloudToken}` },
  });
  if (res.status === 404) {
    return { verified: true, msg: `Hetzner server ${args.serverId} confirmed deleted` };
  }
  return {
    verified: false,
    msg: `Hetzner server ${args.serverId} still resolves (HTTP ${res.status}) after destroy — check the project manually`,
  };
}
