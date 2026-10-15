import crypto from 'crypto';

export const MACHINE_CODE_TTL_SECONDS = 3600;

export interface MachineJoinCode {
  hash: string;
  ownerId: string;
  expiresAt: string;
}

export type MachineAgentState = 'checking' | 'ready' | 'needs-adapter' | 'not-answering';

export interface MachineAgent {
  id: string;
  title: string;
  state: MachineAgentState;
  source: 'found' | 'by-hand';
  command?: string | undefined;
  args?: string[] | undefined;
  name?: string | undefined;
  version?: string | undefined;
  signIn?: string[] | undefined;
  reason?: string | undefined;
  adapter?: string | undefined;
}

export interface ManualMachineAgent {
  id: string;
  title?: string | undefined;
  command: string;
  args: string[];
}

export const hashMachineCode = (code: string): string => crypto.createHash('sha256').update(code).digest('hex');

export const newMachineCode = (): string => crypto.randomBytes(24).toString('base64url');

export const machineCommand = (url: string, code: string): string => `curl -fsSL ${url}/machine.sh | sh -s -- ${code}`;

const STATES: readonly MachineAgentState[] = ['checking', 'ready', 'needs-adapter', 'not-answering'];
const AGENT_ID = /^[a-z][a-z0-9-]{0,39}$/;
const LIMIT = 300;

const short = (value: unknown, limit = LIMIT): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : undefined;

const words = (value: unknown, count = 20): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const kept = value.flatMap((entry) => (typeof entry === 'string' ? [entry.slice(0, LIMIT)] : [])).slice(0, count);
  return kept;
};

export function machineAgentsFrom(raw: unknown): MachineAgent[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 50).flatMap((entry): MachineAgent[] => {
    const candidate = entry as Record<string, unknown> | null;
    if (!candidate || typeof candidate !== 'object') return [];
    const id = short(candidate.id, 40);
    const title = short(candidate.title, 80);
    const state = STATES.find((known) => known === candidate.state);
    const source = candidate.source === 'by-hand' ? 'by-hand' : candidate.source === 'found' ? 'found' : undefined;
    if (!id || !AGENT_ID.test(id) || !title || !state || !source) return [];
    const args = words(candidate.args);
    const signIn = words(candidate.signIn);
    const optional = {
      command: short(candidate.command, 500),
      name: short(candidate.name, 80),
      version: short(candidate.version, 40),
      reason: short(candidate.reason, 1000),
      adapter: short(candidate.adapter, 120),
    };
    return [{
      id, title, state, source,
      ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
      ...(args ? { args } : {}),
      ...(signIn?.length ? { signIn } : {}),
    }];
  });
}

export function manualAgentsProblem(raw: unknown): string | null {
  if (!Array.isArray(raw)) return 'send the agents as a list';
  const seen = new Set<string>();
  for (const entry of raw as Partial<ManualMachineAgent>[]) {
    if (!entry || typeof entry !== 'object') return 'each agent needs an id and a command';
    if (typeof entry.id !== 'string' || !AGENT_ID.test(entry.id)) return 'an agent\'s id is lowercase letters, digits and dashes, starting with a letter (like antigravity)';
    if (seen.has(entry.id)) return `${entry.id} is listed twice`;
    seen.add(entry.id);
    if (typeof entry.command !== 'string' || !entry.command.trim()) return `${entry.id} needs the command that starts it`;
    if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some((arg) => typeof arg !== 'string'))) return `${entry.id}'s arguments must be words`;
    if (entry.title !== undefined && typeof entry.title !== 'string') return `${entry.id}'s title must be text`;
  }
  return null;
}

export function manualAgentsOf(raw: unknown): ManualMachineAgent[] {
  if (manualAgentsProblem(raw) !== null) return [];
  return (raw as ManualMachineAgent[]).map((entry) => ({
    id: entry.id,
    ...(entry.title?.trim() ? { title: entry.title.trim() } : {}),
    command: entry.command.trim(),
    args: entry.args ?? [],
  }));
}

const quoted = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export function joinEnv(values: Record<string, string>): string {
  return `${Object.entries(values).map(([name, value]) => `${name}=${quoted(value)}`).join('\n')}\n`;
}

export interface ChosenMachine {
  name: string;
  online: boolean;
  agents: readonly MachineAgent[];
}

export function machineChoiceProblem(machine: ChosenMachine | undefined, agent: string, opts: { waitsToConnect?: boolean } = {}): string | undefined {
  if (!machine) return 'that machine is not one of yours any more; pick another on My Machines or in the model list';
  const found = machine.agents.find((candidate) => candidate.id === agent);
  if (!found) return `${machine.name} has no agent called ${agent}`;
  if (found.state !== 'ready') return `${found.title} on ${machine.name} is not ready: ${found.reason ?? found.state}`;
  if (!machine.online && !opts.waitsToConnect) return `${machine.name} is not connected, so ${found.title} cannot answer`;
  return undefined;
}
