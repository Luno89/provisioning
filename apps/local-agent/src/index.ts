import { mkdir } from 'fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { configFile, loadMachineConfig } from './machine-config.js';
import { linkToRoot } from './root-link.js';
import { systemDeps } from './agent-discovery.js';
import { probeAcp } from './acp-session.js';
import { installAgent } from './agent-install.js';
import { ADAPTER_CHOICES, setUpAgents, type AdapterChoice } from './agent-setup.js';
import { askOnTerminal } from './terminal-ask.js';
import { ExternalAgentSessions } from './external-agents.js';
import { startWork, type AgentPlace } from './agent-work.js';
import { forgetThisMachine, meshIp, removeThisMachine } from './machine-removal.js';
import { hostCluster, startIfWanted } from './machine-cluster.js';
import { installKoala, ownValuesFile, placedFrom } from './koala-install.js';
import { useDependencyHttp } from '@koala/engine-core/http';
import { serviceManagerOf } from './self-update.js';
import { ownBundle, ownVersion, readCgroup } from './agent-bundle.js';

const AGENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OWN_BUNDLE = ownBundle(AGENT_DIR);

const machineCluster = hostCluster(meshIp, { machineRoot: process.env.KOALA_MACHINE_ROOT || '/' });

const say = (line: string) => console.log(`[koala-local-agent] ${line}`);

const helmBinary = (env: NodeJS.ProcessEnv = process.env) => path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'koala', 'bin', 'helm');

let placing = false;
const placeKoala = (raw: unknown): boolean => {
  const placed = placedFrom(raw);
  if (!placed || placing) return false;
  placing = true;
  say(`root asks for Koala on this machine (${placed.instanceId})`);
  void installKoala(placed, { cluster: machineCluster, helm: helmBinary(), fetch, say, ownValues: ownValuesFile() }).finally(() => { placing = false; });
  return true;
};

const forgetAndStop = (closing: () => Promise<unknown>) => {
  void closing()
    .finally(() => removeHere().catch((err: Error) => say(err.message)))
    .finally(() => process.exit(0));
};

const removeHere = () => removeThisMachine(machineCluster, () => forgetThisMachine(say), say);

const thisComputer = (service: ReturnType<typeof serviceManagerOf>): AgentPlace => ({
  agentDir: AGENT_DIR,
  ownBundle: OWN_BUNDLE,
  service,
  cluster: machineCluster,
  discovery: (rootDir) => systemDeps(rootDir, probeAcp),
  startDeviceWorker: async (options) => (await import('./engine-worker.js')).startDeviceWorker(options),
  onStop: (stop) => { for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, stop); },
  exit: (code) => process.exit(code),
});

async function main() {
  const config = await loadMachineConfig();
  const { rootUrl, rootDir } = config;
  await mkdir(rootDir, { recursive: true });
  const service = serviceManagerOf(process.platform, process.env, await readCgroup());
  void startIfWanted(machineCluster, say).catch((err: Error) => say(`this machine's cluster could not start again: ${err.message}`));
  let sessionsOf: ExternalAgentSessions | undefined;
  let working: { url: string; setToken(token: string): Promise<void> } | undefined;
  const root = linkToRoot({
    rootUrl,
    token: config.token,
    configFile: configFile(),
    meshIp,
    say,
    onRemoved: () => forgetAndStop(() => sessionsOf?.closeAll() ?? Promise.resolve()),
    onPlaceKoala: placeKoala,
    onKoala: (koala) => {
      if (!working) {
        working = startWork(thisComputer(service), config, koala.url, koala.workToken, () => root.askKoala(), (sessions) => { sessionsOf = sessions; });
        return;
      }
      if (working.url !== koala.url) {
        say(`this machine's Koala is now at ${koala.url}`);
        if (service) process.exit(0);
        say('start the agent again to work for it there');
        return;
      }
      void working.setToken(koala.workToken);
    },
  });
}

async function setUpAgentsHere(args: string[]): Promise<void> {
  const flag = args.indexOf('--adapters');
  const choice = (flag >= 0 ? args[flag + 1] : 'ask') as AdapterChoice;
  if (!ADAPTER_CHOICES.includes(choice)) throw new Error(`--adapters takes ${ADAPTER_CHOICES.join(', ')}`);
  const config = await loadMachineConfig();
  await mkdir(config.rootDir, { recursive: true });
  await setUpAgents(choice, { discovery: systemDeps(config.rootDir, probeAcp), install: (install) => installAgent(install) }, {
    ok: (line) => console.log(`  \x1b[32m✓\x1b[0m ${line}`),
    note: (line) => console.log(`  • ${line}`),
    fail: (line) => console.log(`  \x1b[31m✗\x1b[0m ${line}`),
    ask: askOnTerminal,
  });
}

function sayVersion(): Promise<void> {
  console.log(JSON.stringify({ bundle: OWN_BUNDLE ?? null, version: ownVersion(AGENT_DIR) ?? null }));
  return Promise.resolve();
}

useDependencyHttp();
const command = process.argv[2];
const ONCE = ['agents', 'version', 'remove'];
const started = command === 'agents' ? setUpAgentsHere(process.argv.slice(3)) : command === 'version' ? sayVersion() : command === 'remove' ? removeHere() : main();
started.then(() => {
  if (ONCE.includes(command ?? '')) process.exit(0);
}, (err: Error) => {
  console.error(`[koala-local-agent] fatal: ${err.message}`);
  process.exit(1);
});
