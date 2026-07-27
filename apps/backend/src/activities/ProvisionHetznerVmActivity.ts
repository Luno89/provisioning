/**
 * ProvisionHetznerVmActivity
 *
 * The "create the machine" half of the distributed-systems plan's Phase 3. Creates a Hetzner
 * Cloud VM (via the HetznerVmStack CDKTF stack), waits for it to accept SSH, and hands back the
 * public IP plus the private key needed to reach it — at which point ProvisionClusterActivity
 * feeds both straight into Phase 2's generic SSH k3s bootstrap (ProvisionRemoteHostActivity).
 * A created VM and a user's own GPU workstation are deliberately identical from that point on.
 *
 * The SSH keypair is generated here, per cluster, and never reused: the platform is the only
 * party that needs to log into a VM it created, so minting a throwaway key beats asking the user
 * to upload one, and a leaked key compromises exactly one machine.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { InfrastructureService } from '../services/InfrastructureService.js';

const execFileAsync = promisify(execFile);

export interface ProvisionHetznerVmArgs {
  /** Cluster name — also the VM name and the CDKTF stack suffix. */
  name: string;
  /** Decrypted Hetzner Cloud API token; the caller resolves it (activities can't reach the DB). */
  hcloudToken: string;
  logFile: string;
  serverType?: string;
  location?: string;
  image?: string;
  /**
   * The cluster's persisted keypair. Supplied by the caller so it is IDENTICAL on every attempt:
   * Hetzner bakes authorized_keys into the machine at creation, so a key generated per-attempt
   * locks us out of the server we just paid for from attempt two onward. Omitted only by callers
   * with no cluster record (tests), which then get a throwaway pair.
   */
  sshPrivateKey?: string;
  sshPublicKey?: string;
}

export interface ProvisionHetznerVmResult {
  /** Public IPv4 — what the k3s kubeconfig's server field gets rewritten to. */
  host: string;
  /** Hetzner's numeric server id, recorded so a later destroy can be verified against the API. */
  serverId: string;
  /** PEM private key for the throwaway keypair injected into the VM at boot. */
  privateKey: string;
  username: string;
}

/** Ubuntu cloud images all ship a `root` user with the injected key authorised. */
const HETZNER_SSH_USERNAME = 'root';

export function hetznerVmStackName(clusterName: string): string {
  return `vm-${clusterName}`;
}

/**
 * Fallback only — the caller normally supplies a keypair that was generated once and persisted
 * before the workflow started. See lib/ssh-keypair.ts for why generating one here per attempt is a
 * correctness bug rather than a style choice: cloud VMs inject authorized_keys at creation time
 * only, so the second attempt's key was never on the machine and never can be.
 */
async function generateSshKeypairLocal(name: string): Promise<{ privateKey: string; publicKey: string; cleanup: () => Promise<void> }> {
  const keyPath = path.join(os.tmpdir(), `hetzner-key-${name}-${Date.now()}`);
  // -N '' → no passphrase (nothing could supply one non-interactively later); ed25519 over RSA
  // because every current Ubuntu cloud image accepts it and the keys are far smaller.
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

/**
 * A freshly-created VM answers on port 22 well before cloud-init has finished installing the
 * authorised key, so "the TCP port is open" is not the same as "SSH works" — this runs a real
 * authenticated command and only returns once that succeeds.
 */
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

  // Persisted key when the caller has one — the whole point is that this value does not change
  // between attempts. Falling back to a fresh pair keeps the activity usable standalone, but that
  // path is only safe on a first attempt against a server that does not exist yet.
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
      // Hetzner creates a VM in well under a minute, but the surrounding `cdktf deploy` has to
      // download the hcloud provider on a cold cache — generous enough to absorb that without
      // masking a genuinely stuck apply.
      timeout: 15 * 60 * 1000,
    });

    // Shape is { "<stackName>": { "<outputName>": <value> } } — see `cdktf deploy --outputs-file`.
    const raw = await fs.readFile(outputsFile, 'utf-8');
    const outputs = JSON.parse(raw)?.[stackName] ?? {};
    const host = outputs.ipv4_address;
    const serverId = outputs.server_id;

    if (!host) {
      throw new Error(`Hetzner VM stack ${stackName} produced no ipv4_address output`);
    }

    // waitForSsh needs the key on disk; write it with the same 0600 the ssh client insists on.
    const keyPath = path.join(os.tmpdir(), `hetzner-wait-${args.name}-${Date.now()}`);
    await fs.writeFile(keyPath, privateKey, { mode: 0o600 });
    try {
      await waitForSsh(host, keyPath);
    } finally {
      await fs.rm(keyPath, { force: true });
    }

    const result = { host, serverId: String(serverId ?? ''), privateKey, username: HETZNER_SSH_USERNAME };
    // Only on success. A `finally` here would delete the keypair after a FAILED attempt too, so
    // the retry would generate a new one and force Terraform to rebuild the VM — exactly the loop
    // the stable path above exists to break. The cost of keeping it is a 0600 key left in the temp
    // dir when provisioning ultimately gives up; the caller persists the key encrypted on success,
    // and the retry cap in ClusterProvisionWorkflow bounds how long that can go on.
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
  /** Recorded at create time — lets the destroy be *verified* rather than assumed. */
  serverId?: string;
}

/**
 * Destroys the VM, then confirms against Hetzner's own API that the server is actually gone
 * rather than trusting Terraform's word for it — the plan calls for exactly this, since "removed
 * from our DB" and "no longer being billed for" are very different things.
 */
export async function DestroyHetznerVmActivity(args: DestroyHetznerVmArgs): Promise<{ verified: boolean; msg: string }> {
  const infra = new InfrastructureService();
  const stackName = hetznerVmStackName(args.name);

  await infra.destroy(stackName, {
    logFile: args.logFile,
    env: {
      STACK_TYPE: 'vm',
      CLUSTER_NAME: args.name,
      HCLOUD_TOKEN: args.hcloudToken,
      // The stack can't be synthesized without this, and destroy synthesizes too. The value is
      // irrelevant to a teardown — nothing reads the key back — so a syntactically valid
      // placeholder is enough to let synthesis succeed.
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
