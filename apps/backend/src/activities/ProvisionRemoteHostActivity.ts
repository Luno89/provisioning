import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const execFileAsync = promisify(execFile);

export interface ProvisionRemoteHostArgs {
  physicalName: string;
  host: string; // mesh IP (or any SSH-reachable address) — what the kubeconfig's server field is rewritten to
  username: string;
  privateKey: string;
  port?: number;
  k3sApiPort?: number;
}

export interface ProvisionRemoteHostResult {
  kubeconfigPath: string;
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

export async function ProvisionRemoteHostActivity(
  args: ProvisionRemoteHostArgs,
): Promise<ProvisionRemoteHostResult> {
  const port = args.port ?? 22;
  const kubeconfigPath = `/tmp/kubeconfig-${args.physicalName}`;
  const keyPath = path.join(os.tmpdir(), `ssh-key-${args.physicalName}-${Date.now()}`);

  await fs.writeFile(keyPath, args.privateKey.endsWith('\n') ? args.privateKey : `${args.privateKey}\n`, { mode: 0o600 });

  try {
    const prefix = sshPrefix(args.username);

    const alreadyInstalled = await runSsh(args.host, port, args.username, keyPath, 'command -v k3s')
      .then(() => true)
      .catch(() => false);

    if (!alreadyInstalled) {
      await runSsh(
        args.host, port, args.username, keyPath,
        `curl -sfL https://get.k3s.io | ${prefix}K3S_KUBECONFIG_MODE="644" INSTALL_K3S_EXEC="server --disable=traefik" sh -`,
      );
    }

    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        const nodesJson = await runSsh(args.host, port, args.username, keyPath, `${prefix}k3s kubectl get nodes -o json`);
        const nodes = JSON.parse(nodesJson).items ?? [];
        if (nodes.some((n: any) => n.status?.conditions?.some((c: any) => c.type === 'Ready' && c.status === 'True'))) {
          ready = true;
          break;
        }
      } catch { /* ignored */ }
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (!ready) {
      throw new Error(`k3s on ${args.host} did not report a Ready node in time`);
    }

    const rawKubeconfig = await runSsh(args.host, port, args.username, keyPath, 'cat /etc/rancher/k3s/k3s.yaml');
    const rewritten = rawKubeconfig.replace(/https:\/\/127\.0\.0\.1:6443/g, `https://${args.host}:${args.k3sApiPort ?? 6443}`);
    await fs.writeFile(kubeconfigPath, rewritten, 'utf-8');

    return { kubeconfigPath };
  } finally {
    await fs.rm(keyPath, { force: true });
  }
}

export async function DestroyRemoteHostActivity(args: ProvisionRemoteHostArgs): Promise<void> {
  const port = args.port ?? 22;
  const keyPath = path.join(os.tmpdir(), `ssh-key-destroy-${args.physicalName}-${Date.now()}`);
  await fs.writeFile(keyPath, args.privateKey.endsWith('\n') ? args.privateKey : `${args.privateKey}\n`, { mode: 0o600 });

  try {
    const prefix = sshPrefix(args.username);
    await runSsh(args.host, port, args.username, keyPath, `${prefix}/usr/local/bin/k3s-uninstall.sh`);
  } finally {
    await fs.rm(keyPath, { force: true });
  }
}
