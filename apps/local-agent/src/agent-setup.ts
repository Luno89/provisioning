import { KNOWN_AGENTS, discoverAgents, type AgentInstall, type DiscoveryDeps, type FoundAgent } from './agent-discovery.js';
import type { InstallOutcome } from './agent-install.js';

export type AdapterChoice = 'ask' | 'all' | 'none';

export const ADAPTER_CHOICES: readonly AdapterChoice[] = ['ask', 'all', 'none'];

export interface SetupIo {
  ok(line: string): void;
  note(line: string): void;
  fail(line: string): void;
  ask(question: string): Promise<boolean | undefined>;
}

export interface SetupDeps {
  discovery: DiscoveryDeps;
  install(install: AgentInstall): Promise<InstallOutcome>;
}

const described = (agent: FoundAgent): string => [agent.name && agent.name !== agent.title ? `${agent.title} (${agent.name})` : agent.title, agent.version].filter(Boolean).join(' ');

async function wanted(agent: FoundAgent, choice: AdapterChoice, io: SetupIo, asking: { possible: boolean }): Promise<boolean> {
  if (choice !== 'ask') return choice === 'all';
  if (!asking.possible) return false;
  const answer = await io.ask(`Install ${agent.adapter} for ${agent.title} now?`);
  if (answer === undefined) {
    asking.possible = false;
    io.note('There is no terminal to ask on, so nothing more is installed.');
    return false;
  }
  return answer;
}

export async function setUpAgents(choice: AdapterChoice, deps: SetupDeps, io: SetupIo): Promise<FoundAgent[]> {
  const first = await discoverAgents(deps.discovery, []);
  if (!first.agents.length) {
    io.note('No coding agents were found yet. Install one (Gemini CLI, Antigravity, Claude Code, Codex, Goose) and Koala finds it the next time this machine connects.');
    return first.agents;
  }
  const asking = { possible: true };
  const installed: string[] = [];
  const declined: FoundAgent[] = [];
  for (const agent of first.agents) {
    if (agent.state === 'ready') io.ok(described(agent));
    else if (agent.state === 'not-answering') io.fail(`${agent.title} did not answer: ${agent.reason ?? 'no reason given'}`);
    else if (agent.state === 'needs-adapter') {
      io.note(agent.reason ?? `${agent.title} needs ${agent.adapter}`);
      const install = KNOWN_AGENTS.find((known) => known.id === agent.id)?.install;
      if (!install || !await wanted(agent, choice, io, asking)) {
        declined.push(agent);
        continue;
      }
      const outcome = await deps.install(install);
      if (outcome.ok) installed.push(agent.id);
      else io.fail(`${agent.adapter} was not installed: ${outcome.output}`);
    }
  }
  if (declined.length) io.note(`Install ${declined.map((agent) => agent.title).join(', ')} later with Install adapter on My Machines.`);
  if (!installed.length) return first.agents;

  const after = await discoverAgents(deps.discovery, []);
  for (const id of installed) {
    const agent = after.agents.find((candidate) => candidate.id === id);
    if (agent?.state === 'ready') io.ok(`${described(agent)}, through ${KNOWN_AGENTS.find((known) => known.id === id)?.adapter}`);
    else io.fail(`${agent?.title ?? id} was installed, but ${agent?.reason ?? 'Koala still cannot reach it'}`);
  }
  return after.agents;
}
