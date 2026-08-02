/**
 * ProvisionDigitalOceanVmActivity
 *
 * Creates a DigitalOcean droplet, waits for it to accept SSH, and hands back the public IP plus
 * the key needed to reach it — after which ProvisionClusterActivity feeds both into the same
 * generic SSH k3s bootstrap a user's own workstation goes through. Everything past that handoff
 * is provider-agnostic, exactly as the Hetzner path already is.
 *
 * ── WHY REST RATHER THAN CDKTF ──
 * The Hetzner equivalent drives a CDKTF stack. This does not, deliberately:
 *
 *   - `.gen/` is COMMITTED (9,839 files). Adding a provider means editing cdktf.json and running
 *     `cdktf get`, which regenerates every provider including aws/google/azurerm (184MB between
 *     them). A "add DigitalOcean" commit that churns ten thousand generated files is unreviewable,
 *     and risks silent version drift in bindings the working Hetzner path depends on.
 *   - A droplet is two API calls. Terraform buys state tracking we do not use here — the state
 *     lives in a temp dir per activity run, and the destroy path already verifies against the
 *     provider's API rather than trusting Terraform's word.
 *   - There is precedent: scripts/root-node/provision.ts drives Hetzner over raw REST for the same
 *     reason.
 *
 * The thing Terraform would have given us for free is idempotency across retries, so that is
 * handled explicitly below — by name lookup before create, which is more legible than state anyway.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const execFileAsync = promisify(execFile);

const DO_API = 'https://api.digitalocean.com/v2';

/** Ubuntu cloud images authorise the injected key for `root`, same as Hetzner's. */
const DO_SSH_USERNAME = 'root';

export interface ProvisionDigitalOceanVmArgs {
  /** Cluster name — also the droplet name, and the idempotency key. */
  name: string;
  /** Decrypted DigitalOcean API token; the caller resolves it (activities cannot reach the DB). */
  doToken: string;
  logFile: string;
  size?: string;
  region?: string;
  image?: string;
  /**
   * The cluster's persisted keypair, supplied by the caller so it is IDENTICAL on every attempt.
   * Cloud VMs inject authorized_keys at creation only, so a key generated per-attempt locks us out
   * of the machine we just paid for from attempt two onward — the same correctness bug the Hetzner
   * activity documents.
   */
  sshPrivateKey?: string;
  sshPublicKey?: string;
}

export interface ProvisionDigitalOceanVmResult {
  host: string;
  /** Droplet id, recorded so a later destroy can be verified against the API rather than assumed. */
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
    // DigitalOcean returns { id, message } — surface its own wording, which is specific
    // ("You specified an invalid image for Droplet creation") where a bare status code is not.
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

/**
 * Registers the public key with DigitalOcean, reusing an existing entry with the same name.
 *
 * Unlike Hetzner, DO rejects a duplicate key outright ("SSH Key is already in use on your
 * account"), so a retried activity must find the existing one rather than create a second.
 */
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

/** A droplet already carrying our tag, if a previous attempt got that far. */
async function findExistingDroplet(token: string, name: string): Promise<any | undefined> {
  const res = await doApi(token, `/droplets?per_page=200&name=${encodeURIComponent(name)}`);
  return (res?.droplets ?? []).find((d: any) => d?.name === name);
}

function publicIpv4(droplet: any): string | undefined {
  return (droplet?.networks?.v4 ?? []).find((n: any) => n?.type === 'public')?.ip_address;
}

/**
 * A droplet reports `active` before cloud-init has finished authorising the key, so "the API says
 * active" is not "SSH works" — this runs a real authenticated command and only returns once that
 * succeeds. Same reasoning as the Hetzner activity's waitForSsh.
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
    // Idempotency, in place of Terraform state. A Temporal retry after a timeout must NOT create a
    // second droplet — that bills twice and orphans the first with nothing pointing at it.
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
          // No firewall is attached here on purpose: like constructs/hetzner-vm.ts, the intent is
          // that 6443 is never publicly reachable and the cluster is reached over the mesh.
          tags: ['nowrinkles', `cluster-${args.name}`],
        }),
      });
      droplet = created?.droplet;
      if (!droplet?.id) throw new Error('DigitalOcean did not return a droplet id');
      await log(`Created droplet ${droplet.id}`);
    }

    // Networking is assigned asynchronously — a freshly created droplet has an empty v4 array.
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
  /** Recorded at create time — lets the destroy be verified rather than assumed. */
  serverId?: string;
}

/**
 * Deletes the droplet, then confirms against DigitalOcean's own API that it is gone.
 *
 * "We issued a delete" and "we are no longer being billed" are different claims, and only the
 * second one matters — the same reason the Hetzner destroy re-checks for a 404.
 */
export async function DestroyDigitalOceanVmActivity(
  args: DestroyDigitalOceanVmArgs,
): Promise<{ verified: boolean; msg: string }> {
  const log = async (msg: string) => {
    await fs.appendFile(args.logFile, `[digitalocean] ${msg}\n`).catch(() => {});
  };

  // Fall back to a name lookup: a destroy can be triggered for a cluster whose record predates the
  // droplet id being persisted, and leaving a machine running is the expensive failure here.
  //
  // The lookup deliberately does NOT swallow errors. Swallowing them made an invalid token report
  // "nothing to delete" — indistinguishable from success, while the droplet kept running and
  // billing. A teardown that cannot reach the provider must fail loudly so it can be retried;
  // "we could not check" is not "it is gone".
  let serverId = args.serverId;
  if (!serverId) {
    const found = await findExistingDroplet(args.doToken, args.name);
    serverId = found?.id ? String(found.id) : undefined;
  }
  if (!serverId) {
    return { verified: true, msg: `No droplet named ${args.name} exists — nothing to delete` };
  }

  await doApi(args.doToken, `/droplets/${serverId}`, { method: 'DELETE' }).catch(async (err) => {
    // Already gone is success, not failure.
    if (!/404|not found/i.test(String(err?.message))) throw err;
    await log(`Droplet ${serverId} was already absent`);
  });

  // Deletion is asynchronous; poll rather than reporting an unverified success immediately.
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
