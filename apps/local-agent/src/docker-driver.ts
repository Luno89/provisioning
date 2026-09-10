import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { runDocker, dockerAvailable, type DockerResult } from './docker-cli.js';

export interface EgressRule {
  host: string;
  ports?: number[];
}

export interface CreateContainerOptions {
  leafId: string;
  image: string;
  rootDir: string;
  cpu?: string;
  memory?: string;
  egress?: EgressRule[];
}

const PROXY_CONTAINER_NAME = 'koala-egress-proxy';
const PROXY_PORT = 38080;
const CONTROL_PORT = 38081;
const AGENT_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A standalone install of this package has `tsx` in its own `node_modules/.bin` — but inside this
 * monorepo, npm workspaces hoists it to the repo root instead, so the local-agent package's own
 * `node_modules` doesn't have it. Walk up until a `node_modules/.bin/tsx` is found, and mount
 * *that* directory instead, computing the script's path relative to it — works either way.
 */
function resolveAgentMount(): { hostDir: string; scriptPath: string } {
  let dir = AGENT_PACKAGE_ROOT;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'node_modules', '.bin', 'tsx'))) {
      const scriptPath = path.relative(dir, path.join(AGENT_PACKAGE_ROOT, 'src', 'egress-proxy.ts'));
      return { hostDir: dir, scriptPath };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not find a node_modules/.bin/tsx to run the local egress proxy with — run `npm install` first.');
}

const containerName = (leafId: string): string => `koala-leaf-${leafId}`;
const networkName = (leafId: string): string => `koala-leaf-net-${leafId}`;

const leafContainerIps = new Map<string, string>();
let proxyReady: Promise<void> | undefined;

/** Test-only: this module otherwise intentionally caches proxy-readiness for the agent's whole lifetime. */
export function __resetForTests(): void {
  proxyReady = undefined;
  leafContainerIps.clear();
}

async function containerIpOnNetwork(name: string, network: string, timeoutMs = 15_000): Promise<string> {
  // Docker network names contain hyphens, which Go's text/template can't parse as a bare `.Field`
  // selector — `index` is the standard workaround for a map key with special characters.
  const result = await runDocker(
    ['inspect', name, '--format', `{{index .NetworkSettings.Networks "${network}" "IPAddress"}}`],
    { timeoutMs },
  );
  const ip = result.stdout.trim();
  if (result.exitCode !== 0 || !ip) {
    throw new Error(`Could not resolve ${name}'s address on ${network}: ${result.stderr || result.stdout}`);
  }
  return ip;
}

async function ensureProxyContainer(): Promise<void> {
  if (!proxyReady) {
    proxyReady = (async () => {
      const running = await runDocker(['inspect', '-f', '{{.State.Running}}', PROXY_CONTAINER_NAME], { timeoutMs: 10_000 });
      if (running.exitCode === 0 && running.stdout.trim() === 'true') return;

      const { hostDir, scriptPath } = resolveAgentMount();
      const started = await runDocker([
        'run', '-d', '--rm', '--name', PROXY_CONTAINER_NAME,
        '-p', `127.0.0.1:${CONTROL_PORT}:${CONTROL_PORT}`,
        '-v', `${hostDir}:/agent:ro`,
        '-w', '/agent',
        '-e', `PROXY_PORT=${PROXY_PORT}`,
        '-e', `CONTROL_PORT=${CONTROL_PORT}`,
        'node:20-alpine',
        'node_modules/.bin/tsx', scriptPath,
      ], { timeoutMs: 30_000 });
      if (started.exitCode !== 0) {
        throw new Error(`Could not start the local egress proxy: ${started.stderr || started.stdout}`);
      }

      const deadline = Date.now() + 15_000;
      for (;;) {
        try {
          const res = await fetch(`http://127.0.0.1:${CONTROL_PORT}/allowlist/probe`, { method: 'DELETE' });
          if (res.ok) return;
        } catch { /* not up yet */ }
        if (Date.now() > deadline) throw new Error('The local egress proxy never became reachable');
        await new Promise((r) => setTimeout(r, 300));
      }
    })().catch((err) => { proxyReady = undefined; throw err; });
  }
  return proxyReady;
}

async function setProxyAllowlist(containerIp: string, rules: EgressRule[]): Promise<void> {
  await fetch(`http://127.0.0.1:${CONTROL_PORT}/allowlist`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ containerIp, rules }),
  });
}

async function clearProxyAllowlist(containerIp: string): Promise<void> {
  await fetch(`http://127.0.0.1:${CONTROL_PORT}/allowlist/${encodeURIComponent(containerIp)}`, { method: 'DELETE' })
    .catch(() => undefined);
}

export { dockerAvailable };

export async function createContainer(opts: CreateContainerOptions): Promise<void> {
  await ensureProxyContainer();

  const net = networkName(opts.leafId);
  const name = containerName(opts.leafId);

  const netCreate = await runDocker(['network', 'create', '--internal', net], { timeoutMs: 15_000 });
  if (netCreate.exitCode !== 0) throw new Error(`Could not create network ${net}: ${netCreate.stderr}`);

  const connect = await runDocker(['network', 'connect', net, PROXY_CONTAINER_NAME], { timeoutMs: 15_000 });
  if (connect.exitCode !== 0) throw new Error(`Could not attach the egress proxy to ${net}: ${connect.stderr}`);

  const proxyIp = await containerIpOnNetwork(PROXY_CONTAINER_NAME, net);
  const proxyUrl = `http://${proxyIp}:${PROXY_PORT}`;

  const run = await runDocker([
    'run', '-d', '--rm', '--name', name,
    '--user', '1000:1000',
    '--read-only',
    '--tmpfs', '/tmp',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--cpus', opts.cpu ?? '2',
    '--memory', opts.memory ?? '2g',
    '-v', `${opts.rootDir}:/work`,
    '-w', '/work',
    '--network', net,
    '-e', `HTTP_PROXY=${proxyUrl}`,
    '-e', `HTTPS_PROXY=${proxyUrl}`,
    '-e', `http_proxy=${proxyUrl}`,
    '-e', `https_proxy=${proxyUrl}`,
    opts.image,
    'sleep', 'infinity',
  ], { timeoutMs: 60_000 });
  if (run.exitCode !== 0) throw new Error(`Could not start container ${name}: ${run.stderr}`);

  const containerIp = await containerIpOnNetwork(name, net);
  leafContainerIps.set(opts.leafId, containerIp);
  await setProxyAllowlist(containerIp, opts.egress ?? []);
}

export async function execInContainer(leafId: string, command: string, timeoutMs: number): Promise<DockerResult> {
  return runDocker(['exec', containerName(leafId), 'sh', '-c', command], { timeoutMs });
}

export async function writeFileInContainer(leafId: string, relativePath: string, content: string): Promise<void> {
  const result = await runDocker(
    ['exec', '-i', containerName(leafId), 'sh', '-c', 'mkdir -p "$(dirname "$1")" && base64 -d > "$1"', 'sh', relativePath],
    { stdin: Buffer.from(content, 'utf8').toString('base64') },
  );
  if (result.exitCode !== 0) throw new Error(`Could not write ${relativePath}: ${result.stderr}`);
}

export async function readFileInContainer(leafId: string, relativePath: string): Promise<string> {
  const result = await runDocker(['exec', containerName(leafId), 'sh', '-c', 'base64 "$1"', 'sh', relativePath]);
  if (result.exitCode !== 0) throw new Error(`Could not read ${relativePath}: ${result.stderr}`);
  return Buffer.from(result.stdout, 'base64').toString('utf8');
}

export async function destroyContainer(leafId: string): Promise<void> {
  const net = networkName(leafId);
  const containerIp = leafContainerIps.get(leafId);

  await runDocker(['stop', containerName(leafId)], { timeoutMs: 20_000 }).catch(() => undefined);
  if (containerIp) {
    await clearProxyAllowlist(containerIp);
    leafContainerIps.delete(leafId);
  }
  await runDocker(['network', 'disconnect', '-f', net, PROXY_CONTAINER_NAME], { timeoutMs: 10_000 }).catch(() => undefined);
  await runDocker(['network', 'rm', net], { timeoutMs: 10_000 }).catch(() => undefined);
}
