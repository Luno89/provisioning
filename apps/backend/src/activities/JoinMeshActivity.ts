/**
 * Joins a freshly provisioned host to the Headscale mesh over SSH, and reports its mesh IP.
 *
 * Why this exists: `constructs/hetzner-vm.ts` deliberately opens no inbound rule for 6443 — the
 * k3s API server is meant to be reachable only inside the WireGuard tunnel. Until something
 * actually joins the mesh, that leaves a cluster which provisions to 'healthy' and is then
 * unreachable, which is exactly what the first live Hetzner run hit:
 * `dial tcp <public-ip>:6443: i/o timeout`.
 *
 * Why over SSH rather than cloud-init: the pre-auth key is a credential. Passing it as
 * `user_data` would persist it into Terraform state AND the provider's own console, where it long
 * outlives the join it was needed for. This repo already treats that as a hard line (see the
 * sentinel-password grep in tests/palworld-synth.ts). We are already SSH'd in to install k3s, so
 * the join rides the same proven path and the key never touches Terraform.
 *
 * The mesh is OPT-IN. With no public login server configured the caller skips this entirely and
 * keeps the existing public-IP behaviour, so a local dev box is unaffected.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const execFileAsync = promisify(execFile);

export interface JoinMeshArgs {
  /** Used only to name temp files and the mesh hostname. */
  physicalName: string;
  /** Where to SSH — the PUBLIC address, since the mesh IP is what we are here to discover. */
  host: string;
  port?: number;
  username: string;
  /** PEM, already decrypted by the caller. */
  privateKey: string;
  /** Public Headscale URL, e.g. https://mesh.example.com. Never localhost — see module docstring. */
  loginServer: string;
  /** Single-tenant pre-auth key from HeadscaleService.createPreAuthKey(ownerId). */
  preAuthKey: string;
}

export interface JoinMeshResult {
  /** The 100.64.0.0/10 address this node is reachable at from the root node. */
  meshIp: string;
}

/** Same shape as ProvisionRemoteHostActivity's — root needs no sudo, anyone else needs it passwordless. */
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

/** 100.64.0.0/10 — the CGNAT range Headscale allocates from (see headscale/config/config.yaml). */
function isMeshIp(ip: string): boolean {
  const m = ip.trim().match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 100 && b >= 64 && b <= 127;
}

export async function JoinMeshActivity(args: JoinMeshArgs): Promise<JoinMeshResult> {
  if (/localhost|127\.0\.0\.1/.test(args.loginServer)) {
    // Would "succeed" by telling the VM to contact itself. Better to fail loudly here than to
    // hand back a mesh IP that nothing can route to.
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

    // Idempotent, like the k3s install it sits next to: a retried Temporal attempt against a host
    // that already joined must not re-run the installer or burn a second pre-auth key.
    const existing = await ssh(`${prefix}tailscale ip -4 2>/dev/null || true`).catch(() => '');
    if (isMeshIp(existing)) {
      return { meshIp: existing.trim().split('\n')[0]!.trim() };
    }

    const installed = await ssh('command -v tailscale').then(() => true).catch(() => false);
    if (!installed) {
      await ssh(`${prefix}sh -c 'curl -fsSL https://tailscale.com/install.sh | sh'`);
    }

    // --ssh is deliberately NOT passed: this platform authenticates to hosts with its own key, and
    // enabling Tailscale SSH would add a second, ACL-governed path onto tenant machines.
    // --accept-routes likewise off — we want a flat mesh IP, not other nodes' subnets.
    //
    // The key is passed on the remote command line, so it is briefly visible in that host's
    // process list. Acceptable: it is single-tenant, short-lived, and the host is one we just
    // created and nobody else has access to yet. It never reaches Terraform state or our logs.
    await ssh(
      `${prefix}tailscale up --login-server=${args.loginServer} --authkey=${args.preAuthKey} --hostname=${args.physicalName} --accept-routes=false`,
    );

    // Allocation is not always instant after `up` returns.
    let meshIp = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      const out = await ssh(`${prefix}tailscale ip -4 2>/dev/null || true`).catch(() => '');
      const candidate = out.trim().split('\n')[0]?.trim() ?? '';
      if (isMeshIp(candidate)) {
        meshIp = candidate;
        break;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }

    if (!meshIp) {
      throw new Error(
        `Host joined the mesh but never reported a 100.64.0.0/10 address (last seen: "${(await ssh(`${prefix}tailscale status 2>&1 | head -3 || true`).catch(() => 'unavailable')).trim()}")`,
      );
    }

    return { meshIp };
  } finally {
    await fs.rm(keyPath, { force: true });
  }
}
