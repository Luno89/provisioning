import { access, constants } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AcpLaunch, AcpProbe } from './acp-session.js';

export interface KnownAgent {
  id: string;
  title: string;
  launches: AcpLaunch[];
  cli?: string | undefined;
  adapter?: string | undefined;
}

export const KNOWN_AGENTS: readonly KnownAgent[] = [
  { id: 'gemini', title: 'Gemini CLI', launches: [{ command: 'gemini', args: ['--acp'] }, { command: 'gemini', args: ['--experimental-acp'] }] },
  { id: 'antigravity', title: 'Antigravity', launches: [{ command: 'agy_acp_server.par', args: ['--uid='] }] },
  { id: 'claude', title: 'Claude Code', launches: [{ command: 'claude-code-acp', args: [] }], cli: 'claude', adapter: '@zed-industries/claude-code-acp' },
  { id: 'codex', title: 'Codex', launches: [{ command: 'codex-acp', args: [] }], cli: 'codex', adapter: '@zed-industries/codex-acp' },
  { id: 'goose', title: 'Goose', launches: [{ command: 'goose', args: ['acp'] }] },
];

export type AgentState = 'checking' | 'ready' | 'needs-adapter' | 'not-answering';

export interface FoundAgent {
  id: string;
  title: string;
  state: AgentState;
  source: 'found' | 'by-hand';
  command?: string | undefined;
  args?: string[] | undefined;
  name?: string | undefined;
  version?: string | undefined;
  signIn?: string[] | undefined;
  reason?: string | undefined;
  adapter?: string | undefined;
}

export interface ManualAgent {
  id: string;
  title?: string | undefined;
  command: string;
  args: string[];
}

export interface DiscoveryDeps {
  which(command: string): Promise<string | undefined>;
  probe(launch: AcpLaunch): Promise<AcpProbe>;
}

const AGENT_ID = /^[a-z][a-z0-9-]{0,39}$/;

export function manualAgentsFrom(raw: unknown): ManualAgent[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): ManualAgent[] => {
    const candidate = entry as Partial<ManualAgent> | null;
    if (!candidate || typeof candidate.id !== 'string' || !AGENT_ID.test(candidate.id)) return [];
    if (typeof candidate.command !== 'string' || !candidate.command.trim()) return [];
    const args = Array.isArray(candidate.args) ? candidate.args.filter((arg): arg is string => typeof arg === 'string') : [];
    return [{ id: candidate.id, ...(typeof candidate.title === 'string' && candidate.title.trim() ? { title: candidate.title.trim() } : {}), command: candidate.command.trim(), args }];
  });
}

const expandHome = (command: string): string => (command === '~' || command.startsWith('~/') ? path.join(os.homedir(), command.slice(1)) : command);

const executable = async (file: string): Promise<boolean> => access(file, constants.X_OK).then(() => true, () => false);

export async function onPath(command: string, envPath: string | undefined = process.env.PATH): Promise<string | undefined> {
  const expanded = expandHome(command);
  if (expanded.includes('/')) return (await executable(expanded)) ? path.resolve(expanded) : undefined;
  for (const dir of (envPath ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, expanded);
    if (await executable(candidate)) return candidate;
  }
  return undefined;
}

export const systemDeps = (cwd: string, probe: (launch: AcpLaunch, cwd: string) => Promise<AcpProbe>): DiscoveryDeps => ({
  which: (command) => onPath(command),
  probe: (launch) => probe(launch, cwd),
});

interface Candidate {
  agent: FoundAgent;
  launches: AcpLaunch[];
}

async function candidateOf(known: KnownAgent, deps: DiscoveryDeps): Promise<Candidate | undefined> {
  const launches: AcpLaunch[] = [];
  for (const launch of known.launches) {
    const found = await deps.which(launch.command);
    if (found) launches.push({ ...launch, command: found });
  }
  if (launches.length) return { agent: { id: known.id, title: known.title, state: 'checking', source: 'found', command: launches[0]!.command, args: launches[0]!.args }, launches };
  if (known.cli && known.adapter && await deps.which(known.cli)) {
    return { agent: { id: known.id, title: known.title, state: 'needs-adapter', source: 'found', adapter: known.adapter, reason: `${known.title} is installed, but it speaks ACP through ${known.adapter}, which is not installed` }, launches: [] };
  }
  return undefined;
}

async function manualCandidate(manual: ManualAgent, deps: DiscoveryDeps): Promise<Candidate> {
  const title = manual.title ?? manual.id;
  const found = await deps.which(manual.command);
  if (!found) return { agent: { id: manual.id, title, state: 'not-answering', source: 'by-hand', command: manual.command, args: manual.args, reason: `${manual.command} is not on this machine` }, launches: [] };
  return { agent: { id: manual.id, title, state: 'checking', source: 'by-hand', command: found, args: manual.args }, launches: [{ command: found, args: manual.args }] };
}

async function confirm(candidate: Candidate, deps: DiscoveryDeps): Promise<{ agent: FoundAgent; launch?: AcpLaunch | undefined }> {
  let reason = '';
  for (const launch of candidate.launches) {
    try {
      const probed = await deps.probe(launch);
      return {
        agent: {
          ...candidate.agent,
          state: 'ready',
          command: launch.command,
          args: launch.args,
          name: probed.identity.title ?? probed.identity.name,
          ...(probed.identity.version ? { version: probed.identity.version } : {}),
          ...(probed.signIn.length ? { signIn: probed.signIn } : {}),
          reason: undefined,
        },
        launch,
      };
    } catch (err) {
      reason = (err as Error).message.split('\n')[0] ?? 'it did not answer';
    }
  }
  return { agent: { ...candidate.agent, state: 'not-answering', reason: reason || candidate.agent.reason } };
}

export interface Discovered {
  agents: FoundAgent[];
  launches: Record<string, AcpLaunch>;
}

export async function discoverAgents(deps: DiscoveryDeps, manual: readonly ManualAgent[], report: (agents: FoundAgent[]) => void = () => {}): Promise<Discovered> {
  const byHand = new Set(manual.map((entry) => entry.id));
  const candidates: Candidate[] = [];
  for (const known of KNOWN_AGENTS) {
    if (byHand.has(known.id)) continue;
    const candidate = await candidateOf(known, deps);
    if (candidate) candidates.push(candidate);
  }
  for (const entry of manual) candidates.push(await manualCandidate(entry, deps));

  const agents = candidates.map((candidate) => candidate.agent);
  const launches: Record<string, AcpLaunch> = {};
  report([...agents]);
  await Promise.all(candidates.map(async (candidate, index) => {
    if (candidate.agent.state !== 'checking') return;
    const settled = await confirm(candidate, deps);
    agents[index] = settled.agent;
    if (settled.launch) launches[candidate.agent.id] = settled.launch;
    report([...agents]);
  }));
  return { agents, launches };
}
