/**
 * provision.ts — Create the root node from nothing: VM, DNS, and platform.
 *
 * Runs from a workstation, not from the platform, because the platform cannot provision the host
 * it runs on. It reads the Hetzner and Cloudflare tokens straight out of the local credential
 * store, so there is nothing to paste and no token in a shell history.
 *
 *   npm run provision:root-node -- --yes
 *   npm run provision:root-node -- --yes --server-type cx43   # smaller
 *
 * SPENDS MONEY: a CX53 is about EUR 35/month, billed hourly. Without --yes it prints the plan and
 * stops.
 *
 * Idempotent, and deliberately so at every step that costs something: a second run reuses the
 * existing server rather than creating another, and updates DNS records in place rather than
 * stacking duplicates.
 */
import { config as loadEnv } from 'dotenv';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createDatabase } from '../../apps/backend/src/lib/db-interface.js';
import { decryptValue } from '../../apps/backend/src/lib/crypto.js';
import { generateSshKeypair } from '../../apps/backend/src/lib/ssh-keypair.js';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(HERE, '../../apps/backend/.env') });

const DOMAIN = process.env.ROOT_NODE_DOMAIN || 'nowrinkles.dev';
const SERVER_NAME = process.env.ROOT_NODE_NAME || 'nowrinkles-root';
const LOCATION = process.env.ROOT_NODE_LOCATION || 'nbg1';
const IMAGE = 'ubuntu-24.04';
const REPO_URL = process.env.ROOT_NODE_REPO || 'https://github.com/Luno89/provisioning.git';
const REPO_DIR = '/opt/nowrinkles';
// Persisted next to the script so a re-run can still SSH in. Hetzner injects authorized_keys at
// creation only, so losing this means losing access to the machine entirely.
const KEY_PATH = resolve(HERE, '.root-node-key');

const args = process.argv.slice(2);
const CONFIRMED = args.includes('--yes');
/**
 * Copy THIS machine's JWT_SECRET to the new host instead of letting bootstrap.sh generate one.
 *
 * Only correct when migrating a host whose existing data must stay readable — the secret is the
 * master key for every stored credential. For a fresh host it is a pure downside: it gives a
 * development machine's compromise the power to forge production sessions and decrypt every
 * tenant's cloud credentials.
 */
const CARRY_SECRET = args.includes('--carry-secret');
const SERVER_TYPE = (() => {
  const i = args.indexOf('--server-type');
  return i >= 0 && args[i + 1] ? args[i + 1]! : 'cx53';
})();

const ok = (m: string) => console.log(`  \x1b[32m✅\x1b[0m ${m}`);
const warn = (m: string) => console.log(`  \x1b[33m⚠\x1b[0m  ${m}`);
const step = (m: string) => console.log(`\n\x1b[32m▶\x1b[0m ${m}`);
const die = (m: string): never => { console.error(`  \x1b[31m❌\x1b[0m ${m}`); process.exit(1); };

async function api(base: string, token: string, pathname: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${base}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body?.error?.message ?? body?.errors?.[0]?.message ?? `HTTP ${res.status}`;
    throw new Error(`${pathname} → ${detail}`);
  }
  return body;
}
const hcloud = (t: string, p: string, i?: RequestInit) => api('https://api.hetzner.cloud/v1', t, p, i);
const cf = (t: string, p: string, i?: RequestInit) => api('https://api.cloudflare.com/client/v4', t, p, i);

async function ssh(host: string, command: string): Promise<string> {
  const { stdout } = await execFileAsync('ssh', [
    '-i', KEY_PATH,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=15',
    '-o', 'BatchMode=yes',
    `root@${host}`,
    command,
  ], { maxBuffer: 20 * 1024 * 1024 });
  return stdout;
}

/**
 * Writes the backend .env on the remote host by piping it over SSH's stdin.
 *
 * Piped rather than interpolated into the command line, because JWT_SECRET is the master key for
 * every credential the platform stores: an argument would be visible in the remote host's process
 * list and shell history.
 *
 * Uses spawn rather than execFile, which has no `input` option at all — passing one is silently
 * ignored, and since execFile also never closes the child's stdin, `cat >file` waits forever. That
 * hangs the whole provision after the VM is already created and billing.
 */
async function writeRemoteEnv(host: string, contents: string): Promise<void> {
  const { spawn } = await import('child_process');
  await new Promise<void>((resolveP, rejectP) => {
    const child = spawn('ssh', [
      '-i', KEY_PATH, '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'BatchMode=yes', `root@${host}`,
      `mkdir -p ${REPO_DIR}/apps/backend && umask 077 && cat > ${REPO_DIR}/apps/backend/.env`,
    ], { stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', rejectP);
    child.on('close', (code) => (code === 0 ? resolveP() : rejectP(new Error(`ssh exited ${code} while writing .env`))));
    child.stdin.end(contents);
  });
}

async function main() {
  step('Reading credentials');
  const db = await createDatabase();
  await (db as any).init();
  const users: any[] = await (db as any).getUsers();
  const owner = users.find((u) => u?.credentials?.hetzner?.token && u?.credentials?.cloudflare?.token);
  if (!owner) die('Need both a Hetzner and a Cloudflare token stored under Cloud Accounts.');
  if (!process.env.JWT_SECRET) die('JWT_SECRET is not set — apps/backend/.env did not load.');

  const hcloudToken = decryptValue(owner.credentials.hetzner.token, process.env.JWT_SECRET!);
  const cfToken = decryptValue(owner.credentials.cloudflare.token, process.env.JWT_SECRET!);
  ok('Hetzner and Cloudflare tokens loaded');

  const zones = await cf(cfToken, `/zones?name=${encodeURIComponent(DOMAIN)}`);
  const zoneId = zones?.result?.[0]?.id;
  if (!zoneId) die(`The Cloudflare token cannot see zone "${DOMAIN}".`);
  ok(`Zone ${DOMAIN} (${String(zoneId).slice(0, 8)}…)`);

  if (!CONFIRMED) {
    console.log(`\nWould create:
  server   ${SERVER_NAME}  ${SERVER_TYPE}  ${IMAGE}  ${LOCATION}
  DNS      app.${DOMAIN}, mesh.${DOMAIN}, *.${DOMAIN}   (DNS-only, never proxied)
  secret   ${CARRY_SECRET
    ? "CARRIED FROM THIS MACHINE — only correct when migrating existing data"
    : "freshly generated on the host (pass --carry-secret to migrate instead)"}
  then run bootstrap.sh.

This bills hourly. Re-run with --yes to proceed.`);
    process.exit(0);
  }

  // ── SSH key ──────────────────────────────────────────────────────────────────────────────────
  step('SSH key');
  let publicKey: string;
  try {
    await fs.access(KEY_PATH);
    publicKey = (await fs.readFile(`${KEY_PATH}.pub`, 'utf-8')).trim();
    ok('Reusing the existing key');
  } catch {
    const pair = await generateSshKeypair(`nowrinkles-root-${Date.now()}`);
    await fs.writeFile(KEY_PATH, pair.privateKey, { mode: 0o600 });
    await fs.writeFile(`${KEY_PATH}.pub`, pair.publicKey, { mode: 0o644 });
    publicKey = pair.publicKey.trim();
    ok(`Generated a new key at ${KEY_PATH}`);
  }

  const existingKeys = await hcloud(hcloudToken, '/ssh_keys');
  let keyId = existingKeys.ssh_keys?.find((k: any) => k.name === SERVER_NAME)?.id;
  if (keyId) {
    ok('SSH key already uploaded');
  } else {
    keyId = (await hcloud(hcloudToken, '/ssh_keys', {
      method: 'POST', body: JSON.stringify({ name: SERVER_NAME, public_key: publicKey }),
    })).ssh_key.id;
    ok('SSH key uploaded');
  }

  // ── Firewall ─────────────────────────────────────────────────────────────────────────────────
  // Wider than a tenant cluster's on purpose: this host terminates TLS for everyone. 80 is needed
  // for the ACME HTTP-01 challenge, not just redirects. 6443 stays closed here as everywhere —
  // the root node's own k3s is reached from the host itself.
  step('Firewall');
  const anywhere = ['0.0.0.0/0', '::/0'];
  const rules = [
    { direction: 'in', protocol: 'tcp', port: '22', source_ips: anywhere, description: 'SSH' },
    { direction: 'in', protocol: 'tcp', port: '80', source_ips: anywhere, description: 'HTTP — ACME challenge and redirect' },
    { direction: 'in', protocol: 'tcp', port: '443', source_ips: anywhere, description: 'HTTPS — platform UI, API, Headscale' },
    { direction: 'in', protocol: 'udp', port: '41641', source_ips: anywhere, description: 'WireGuard mesh' },
    { direction: 'in', protocol: 'icmp', source_ips: anywhere, description: 'ping' },
  ];
  const firewalls = await hcloud(hcloudToken, '/firewalls');
  let firewallId = firewalls.firewalls?.find((f: any) => f.name === SERVER_NAME)?.id;
  if (firewallId) {
    await hcloud(hcloudToken, `/firewalls/${firewallId}/actions/set_rules`, { method: 'POST', body: JSON.stringify({ rules }) });
    ok('Firewall rules updated');
  } else {
    firewallId = (await hcloud(hcloudToken, '/firewalls', {
      method: 'POST', body: JSON.stringify({ name: SERVER_NAME, rules }),
    })).firewall.id;
    ok('Firewall created');
  }

  // ── Server ───────────────────────────────────────────────────────────────────────────────────
  step('Server');
  const servers = await hcloud(hcloudToken, '/servers');
  let server = servers.servers?.find((s: any) => s.name === SERVER_NAME);
  if (server) {
    // The single most expensive mistake this script could make is quietly creating a second
    // billable machine on a re-run.
    ok(`Reusing existing server ${server.id} (${server.public_net?.ipv4?.ip})`);
  } else {
    // No user_data. JWT_SECRET is the master key for every stored credential, and cloud-init data
    // persists into the Hetzner console indefinitely — it goes over SSH below instead.
    server = (await hcloud(hcloudToken, '/servers', {
      method: 'POST',
      body: JSON.stringify({
        name: SERVER_NAME, server_type: SERVER_TYPE, image: IMAGE, location: LOCATION,
        ssh_keys: [keyId], firewalls: [{ firewall: firewallId }],
        labels: { managed_by: 'nowrinkles', role: 'root-node' },
      }),
    })).server;
    ok(`Created ${SERVER_TYPE} ${server.id}`);
  }
  const ip = server.public_net?.ipv4?.ip;
  if (!ip) die('Server has no public IPv4.');
  ok(`Public IP ${ip}`);

  // ── DNS ──────────────────────────────────────────────────────────────────────────────────────
  // proxied:false is mandatory, not a preference. Cloudflare's proxy terminates TLS and would
  // replace the certificate Tailscale clients validate, breaking the mesh outright.
  step('DNS');
  for (const name of [`app.${DOMAIN}`, `mesh.${DOMAIN}`, `*.${DOMAIN}`]) {
    const existing = await cf(cfToken, `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}&type=A`);
    const record = existing?.result?.[0];
    const body = JSON.stringify({ type: 'A', name, content: ip, ttl: 60, proxied: false });
    if (record) {
      if (record.content === ip && record.proxied === false) { ok(`${name} already correct`); continue; }
      await cf(cfToken, `/zones/${zoneId}/dns_records/${record.id}`, { method: 'PUT', body });
      ok(`${name} → ${ip} (updated)`);
    } else {
      await cf(cfToken, `/zones/${zoneId}/dns_records`, { method: 'POST', body });
      ok(`${name} → ${ip} (created)`);
    }
  }

  // ── Wait for SSH ─────────────────────────────────────────────────────────────────────────────
  step('Waiting for SSH');
  let reachable = false;
  for (let i = 0; i < 60; i++) {
    try { await ssh(ip, 'true'); reachable = true; break; } catch { await new Promise((r) => setTimeout(r, 5000)); }
  }
  if (!reachable) die(`${ip} never became SSH-reachable. The key is at ${KEY_PATH}.`);
  ok('SSH up');

  // ── Repo and secret ──────────────────────────────────────────────────────────────────────────
  //
  // JWT_SECRET is the master key for every session and every stored credential, so which one the
  // host ends up with is close to irreversible: changing it later makes every credential a tenant
  // has stored permanently undecryptable.
  //
  // Two cases, and they want opposite things:
  //
  //   MIGRATING an existing host — the secret MUST be carried, or the data coming with it cannot
  //   be read. That is the case CLAUDE.md documents, and it is what --carry-secret is for.
  //
  //   A FRESH host, which is the default — the database starts empty, so nothing there was ever
  //   encrypted with the local secret and there is nothing to preserve. Copying a development
  //   machine's secret into production would mean that compromising a laptop lets someone forge
  //   production sessions and decrypt every tenant's cloud credentials, for no benefit at all.
  //   bootstrap.sh generates a fresh one when it finds no .env.
  step(CARRY_SECRET ? 'Placing the repo and carrying JWT_SECRET across' : 'Placing the repo');
  await ssh(ip, 'command -v git >/dev/null || (apt-get update -qq && apt-get install -y -qq git)');
  await ssh(ip, `test -d ${REPO_DIR}/.git || git clone --quiet ${REPO_URL} ${REPO_DIR}`);
  if (CARRY_SECRET) {
    await writeRemoteEnv(ip, `JWT_SECRET=${process.env.JWT_SECRET}\nNODE_ENV=production\n`);
    warn('JWT_SECRET carried from this machine — the dev box and production now share a master key');
  } else {
    ok('Leaving JWT_SECRET to bootstrap.sh, which generates a fresh one for this host');
  }

  // ── Bootstrap ────────────────────────────────────────────────────────────────────────────────
  step('Running bootstrap.sh (this takes a few minutes)');
  const acmeEmail = process.env.ACME_EMAIL || `admin@${DOMAIN}`;
  try {
    const out = await ssh(ip, `cd ${REPO_DIR} && DOMAIN=${DOMAIN} ACME_EMAIL=${acmeEmail} bash scripts/root-node/bootstrap.sh 2>&1 | tail -40`);
    console.log(out.split('\n').map((l) => `    ${l}`).join('\n'));
  } catch (err: any) {
    warn(`bootstrap.sh reported a problem — the server is up, so fix and re-run rather than recreating it:`);
    console.log(String(err.stdout ?? err.message).split('\n').slice(-25).map((l) => `    ${l}`).join('\n'));
    die(`SSH in with:  ssh -i ${KEY_PATH} root@${ip}`);
  }

  step('Done');
  console.log(`
  Platform   https://app.${DOMAIN}
  Mesh       https://mesh.${DOMAIN}
  SSH        ssh -i ${KEY_PATH} root@${ip}

  Next:
    1. systemctl start nowrinkles          (on the host)
    2. Join this desktop to the mesh so it can reach tenant machines
    3. Update later with: bash scripts/root-node/update.sh
`);
  process.exit(0);
}

main().catch((err) => die(err.stack ?? err.message));
