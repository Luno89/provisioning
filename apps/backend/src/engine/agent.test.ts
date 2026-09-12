import { describe, it, expect } from 'vitest';
import {
  callableAgents,
  capabilitiesFor,
  composeAgentPrompt,
  describeEnvironment,
  environmentFor,
  isFork,
  needsWorkspace,
  resolveAgent,
  visibleAgents,
  type AgentDefinition,
} from './agent.js';
import { capabilitiesOf } from './environment.js';
import type { ToolContract } from './tools.js';

const agent = (over: Partial<AgentDefinition> = {}): AgentDefinition => ({
  slug: 'planner',
  name: 'Planner',
  description: 'Breaks work down',
  version: '1',
  prompt: 'You plan work.',
  loop: 'planning',
  tools: ['propose_work'],
  budget: { maxRounds: 8 },
  environment: {},
  ...over,
});

const catalogue: ToolContract[] = [
  { name: 'propose_work', description: 'Propose a unit of work', binding: 'platform' },
  { name: 'search_web', description: 'Search the web', binding: 'network' },
  { name: 'run_command', description: 'Run a shell command', binding: 'environment' },
];

describe('agent resolution', () => {
  const seeded = agent({ slug: 'research', name: 'Research (default)', ownerId: undefined });
  const fork = agent({ slug: 'research', name: 'Research (mine)', ownerId: 'user-1' });
  const other = agent({ slug: 'research', name: 'Research (someone else)', ownerId: 'user-2' });

  it("prefers the caller's own fork over the seeded default", () => {
    expect(resolveAgent([seeded, fork], 'user-1', 'research')?.name).toBe('Research (mine)');
  });

  it('falls back to the seeded default for everyone who has not forked', () => {
    expect(resolveAgent([seeded, fork], 'user-9', 'research')?.name).toBe('Research (default)');
  });

  it("never exposes another user's fork", () => {
    const visible = visibleAgents([seeded, other], 'user-1');
    expect(visible.map((a) => a.name)).toEqual(['Research (default)']);
  });

  it('reports whether a resolved agent is a fork', () => {
    expect(isFork(fork)).toBe(true);
    expect(isFork(seeded)).toBe(false);
  });

  it('returns nothing for an unknown slug', () => {
    expect(resolveAgent([seeded], 'user-1', 'nope')).toBeUndefined();
  });
});

describe('callableAgents', () => {
  it('only lists agents this one is allowed to call', () => {
    const planner = agent({ slug: 'planner', agents: ['research'] });
    const research = agent({ slug: 'research', description: 'Answers questions' });
    const executor = agent({ slug: 'executor' });

    const callable = callableAgents(planner, [planner, research, executor], 'user-1');
    expect(callable.map((a) => a.slug)).toEqual(['research']);
  });

  it('lists nothing when an agent may not delegate', () => {
    expect(callableAgents(agent(), [agent()], 'user-1')).toEqual([]);
  });
});

describe('environmentFor', () => {
  it('gives an agent that needs nothing no machine at all', () => {
    expect(environmentFor(agent())).toMatchObject({ kind: 'none' });
    expect(capabilitiesFor(agent())).toMatchObject({ terminal: false, egress: false });
  });

  it('gives a research-shaped agent egress but no terminal', () => {
    const research = agent({ environment: { egress: true } });
    expect(environmentFor(research)).toMatchObject({ kind: 'none', egress: true });
    expect(capabilitiesFor(research)).toMatchObject({ terminal: false, egress: true });
  });

  it('gives an executor-shaped agent a sandbox with its languages', () => {
    const executor = agent({ environment: { terminal: true, languages: ['node20'] } });
    expect(environmentFor(executor)).toMatchObject({ kind: 'sandbox', languages: ['node20'] });
    expect(capabilitiesFor(executor)).toMatchObject({ terminal: true, filesystem: true });
  });

  it('closes the network on a sandbox unless the agent asked for it', () => {
    expect(capabilitiesFor(agent({ environment: { terminal: true } })).egress).toBe(false);
    expect(capabilitiesFor(agent({ environment: { terminal: true, egress: true } })).egress).toBe(true);
  });

  it('honours an explicit spec over anything inferred', () => {
    const pinned = agent({ environment: {}, environmentSpec: { kind: 'machine', lifecycle: 'persistent' } });
    expect(environmentFor(pinned)).toMatchObject({ kind: 'machine', lifecycle: 'persistent' });
  });

  it('knows which agents are pinned to a workspace someone else holds', () => {
    expect(needsWorkspace(agent({ interface: { workspace: true } }))).toBe(true);
    expect(needsWorkspace(agent())).toBe(false);
  });
});

describe('describeEnvironment', () => {
  it('tells an agent plainly when it has no machine', () => {
    const text = describeEnvironment(capabilitiesOf({ kind: 'none', lifecycle: 'invocation' }));
    expect(text).toContain('no machine of your own');
    expect(text).toContain('cannot run commands');
  });

  it('warns that work on a real machine is not disposable', () => {
    const caps = capabilitiesOf({ kind: 'machine', lifecycle: 'persistent' });
    const text = describeEnvironment(caps, { kind: 'machine', lifecycle: 'persistent' });
    expect(text).toContain('real machine');
    expect(text).toContain('persist');
  });

  it('says a sandbox is thrown away, and names the languages', () => {
    const spec = { kind: 'sandbox' as const, lifecycle: 'invocation' as const, languages: ['node20'] };
    const text = describeEnvironment(capabilitiesOf(spec), spec);
    expect(text).toContain('disposable sandbox');
    expect(text).toContain('node20');
  });
});

describe('composeAgentPrompt', () => {
  it('describes only the tools that actually work here', () => {
    const offline = capabilitiesOf({ kind: 'sandbox', lifecycle: 'invocation', egress: false });
    const composed = composeAgentPrompt({
      agent: agent({ tools: ['propose_work', 'search_web', 'run_command'] }),
      capabilities: offline,
      catalogue,
    });

    expect(composed.text).toContain('propose_work');
    expect(composed.text).toContain('run_command');
    expect(composed.text).not.toContain('search_web');
    expect(composed.withheld).toEqual([
      { name: 'search_web', why: 'this environment cannot reach the network' },
    ]);
  });

  it('offers callable agents as ordinary tools', () => {
    const planner = agent({ slug: 'planner', agents: ['research'] });
    const research = agent({ slug: 'research', description: 'Answers questions with sources' });

    const composed = composeAgentPrompt({
      agent: planner,
      capabilities: capabilitiesOf({ kind: 'none', lifecycle: 'invocation' }),
      catalogue,
      callable: [research],
    });

    expect(composed.tools.map((t) => t.name)).toContain('research');
    expect(composed.text).toContain('Answers questions with sources');
  });

  it('states the declared output contract', () => {
    const composed = composeAgentPrompt({
      agent: agent({ interface: { outputs: ['findings', 'sources'] } }),
      capabilities: capabilitiesOf({ kind: 'none', lifecycle: 'invocation' }),
      catalogue,
    });

    expect(composed.text).toContain('findings, sources');
  });

  it('includes recalled memory when there is any', () => {
    const composed = composeAgentPrompt({
      agent: agent(),
      capabilities: capabilitiesOf({ kind: 'none', lifecycle: 'invocation' }),
      catalogue,
      memory: 'Previously: the database host is postgres.odoo-db.svc.cluster.local',
    });

    expect(composed.text).toContain('postgres.odoo-db');
  });

  it('leads with the agent persona prompt', () => {
    const composed = composeAgentPrompt({
      agent: agent({ prompt: 'You are a careful planner.' }),
      capabilities: capabilitiesOf({ kind: 'none', lifecycle: 'invocation' }),
      catalogue,
    });

    expect(composed.text.startsWith('You are a careful planner.')).toBe(true);
  });

  it('offers no tools at all when the step says none', () => {
    const composed = composeAgentPrompt({
      agent: agent({ tools: ['propose_work'] }),
      capabilities: capabilitiesOf({ kind: 'sandbox', lifecycle: 'invocation' }),
      catalogue,
      allowed: 'none',
    });

    expect(composed.tools).toEqual([]);
    expect(composed.text).not.toContain('Tools you can use');
  });
});
