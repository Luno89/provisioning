import { describe, it, expect } from 'vitest';
import {
  describeAsks,
  describeAvailable,
  describeEnvironment,
  describeWithheld,
  joinSections,
  resolveToolSet,
  type ContextRequest,
  type ResolvedEnvironment,
} from './context.js';
import { ALL_SEEDED_AGENTS } from '../agent/seeds.js';
import type { AgentDefinition } from '../agent/agent.js';
import type { EnvironmentCapabilities, ToolContract } from '@koala/engine-core';
import type { RunWorkspace } from '../environment/workspace.js';

const FULL: EnvironmentCapabilities = {
  terminal: true, filesystem: true, egress: true, git: true, languages: ['node'],
};

const NOTHING: EnvironmentCapabilities = {
  terminal: false, filesystem: false, egress: false, git: false, languages: [],
};

const agent = (over: Partial<AgentDefinition> = {}): AgentDefinition => ({
  ...ALL_SEEDED_AGENTS().find((a) => a.slug === 'executor')!,
  prompt: 'You fix things.',
  tools: ['run_command', 'read_file'],
  ...over,
});

const catalogue: ToolContract[] = [
  { name: 'run_command', description: 'Run a shell command', binding: 'environment', requires: { terminal: true } },
  { name: 'read_file', description: 'Read a file', binding: 'environment', requires: { filesystem: true } },
  { name: 'search_web', description: 'Search the web', binding: 'network' },
  { name: 'request_egress', description: 'Ask for a host to be unblocked', binding: 'platform' },
  { name: 'request_secret', description: 'Ask for a credential', binding: 'platform' },
  { name: 'propose_work', description: 'Propose a unit of work', binding: 'platform' },
  {
    name: 'run_migrations',
    description: 'Apply database migrations',
    binding: 'environment',
    requires: { terminal: true },
    usageGuidance: 'Always dry-run first.',
  },
];

const workspace = (over: Partial<RunWorkspace> = {}): RunWorkspace => ({

  runId: 'run-abc',
  ownerId: 'user-1',
  agent: 'executor',
  image: 'registry.access.redhat.com/ubi9/nodejs-22',
  provides: ['bash', 'git', 'node', 'npm', 'python3'],
  egressMode: 'declared',
  lifetimeMs: 30 * 60_000,
  cpu: '2',
  memory: '2Gi',
  egress: [{ namespace: 'koala-registry', ports: [4873] }],
  env: [{ name: 'NPM_CONFIG_REGISTRY', value: 'http://verdaccio.koala-registry.svc.cluster.local:4873' }],
  ...over,
});

const sandbox = (over: Partial<RunWorkspace> = {}): ResolvedEnvironment => ({
  kind: 'sandbox',
  workspace: workspace(over),
});

const compose = (over: Partial<ContextRequest> = {}) => {
  const request: ContextRequest = { agent: agent(), environment: sandbox(), capabilities: FULL, catalogue, ...over };
  const { tools, withheld } = resolveToolSet(request);

  return {
    tools,
    withheld,
    text: joinSections([
      describeEnvironment(request.environment, request.callable),
      describeAvailable(tools),
      describeWithheld(withheld),
      describeAsks(request.environment, tools),
    ]),
  };
};

describe('the environment the model is told about', () => {
  it('describes the real image, not a generic sandbox', () => {
    const { text } = compose();

    expect(text).toContain('ubi9/nodejs-22');
    expect(text).toContain('node');
  });

  it('names what is NOT installed, so the model does not plan around it', () => {
    const { text } = compose();

    expect(text).toMatch(/NOT installed:.*go/);
  });

  it('says what the network actually allows, from the same rules the pod is built with', () => {
    const { text } = compose({
      environment: sandbox({ egress: [], env: [] }),
    });

    expect(text).toContain('NO outbound network');
  });

  it('tells an agent that only delegates where that work will run, without handing it a shell', () => {
    const { text } = compose({
      agent: agent({ tools: [], agents: ['hands'] }),
      environment: { kind: 'none', egress: false, bases: ['node', 'python'] },
      capabilities: NOTHING,
      callable: [{ ...agent({ slug: 'hands' }), interface: { workspace: true } }],
    });

    expect(text).toContain('WHERE THE WORK YOU PROPOSE WILL RUN');
    expect(text).not.toContain('You run shell commands');
  });

  it('says nothing about containers to an agent that delegates to nobody', () => {
    const { text } = compose({
      agent: agent({ tools: [] }),
      environment: { kind: 'none', egress: false, bases: ['node', 'python'] },
      capabilities: NOTHING,
    });

    expect(text).not.toContain('WHERE THE WORK YOU PROPOSE WILL RUN');
  });

  it('does not pretend a run with no machine has one', () => {
    const { text } = compose({
      environment: { kind: 'none', egress: false },
      capabilities: NOTHING,
    });

    expect(text).toContain('You have no machine this turn');
    expect(text).toContain('cannot run commands');
  });

  it('is honest that your own machine is not a sandbox and is not contained', () => {
    const { text } = compose({
      environment: { kind: 'machine', deviceName: 'Tallgeese', root: '~/code/thing', egressMode: 'auto' },
    });

    expect(text).toContain('Tallgeese');
    expect(text).toContain('not a sandbox');
    expect(text).toContain('~/code/thing');
    expect(text).toMatch(/approval before it runs/);
  });
});

describe('the tools the model is told about', () => {
  it('lists what it can actually call, with any guidance the catalogue carries', () => {
    const { text, tools } = compose({ agent: agent({ tools: ['run_migrations'] }) });

    expect(tools.map((tool) => tool.name)).toEqual(['run_migrations']);
    expect(text).toContain('- run_migrations: Apply database migrations\n  Always dry-run first.');
  });

  it('names a granted tool it cannot use here, and why', () => {
    const { text } = compose({
      agent: agent({ tools: ['run_command', 'propose_work'] }),
      environment: { kind: 'none', egress: false },
      capabilities: NOTHING,
    });

    expect(text).toContain('NOT AVAILABLE TO YOU THIS TURN');
    expect(text).toMatch(/run_command: .*command/);
    expect(text).toContain('Do not call these');
  });

  it('keeps a web tool even in a sandbox with no egress, since the server performs it', () => {
    const { tools } = compose({
      agent: agent({ tools: ['search_web'] }),
      capabilities: { ...FULL, egress: false },
    });

    expect(tools.map((tool) => tool.name)).toEqual(['search_web']);
  });

  it('says nothing about withheld tools when none are withheld', () => {
    const { text } = compose();
    expect(text).not.toContain('NOT AVAILABLE TO YOU THIS TURN');
  });

  it('offers a delegate agent as a tool the model can call', () => {
    const research = ALL_SEEDED_AGENTS().find((a) => a.slug === 'research')!;
    const { text, tools } = compose({
      agent: agent({ tools: [], agents: ['research'] }),
      callable: [research],
    });

    expect(tools.map((tool) => tool.name)).toContain('research');
    expect(text).toContain('research:');
  });
});

describe('what the model is expected to ask for', () => {
  it('tells it how to get a blocked host unblocked, when it can ask', () => {
    const { text } = compose({ agent: agent({ tools: ['run_command', 'request_egress'] }) });

    expect(text).toContain('WHEN YOU CANNOT PROCEED');
    expect(text).toContain('request_egress');
    expect(text).toContain('Do not work around a blocked host');
  });

  it('stays silent about asking when the agent has no way to ask', () => {
    const { text } = compose();
    expect(text).not.toContain('request_egress');
  });

  it('tells it to ask for credentials instead of guessing them', () => {
    const { text } = compose({ agent: agent({ tools: ['request_secret'] }) });

    expect(text).toMatch(/Never guess one/);
  });

  it('tells it to propose bigger work rather than doing it uninvited', () => {
    const { text } = compose({ agent: agent({ tools: ['propose_work'] }) });

    expect(text).toMatch(/rather than doing it uninvited/);
  });

  it('says a declared allowlist is final, so it stops retrying a blocked host', () => {
    const { text } = compose();
    expect(text).toMatch(/no retry changes that/);
  });

  it('says plainly when egress is open instead of implying a restriction', () => {
    const { text } = compose({ environment: sandbox({ egressMode: 'auto' }) });

    expect(text).toContain('Outbound network is open');
    expect(text).not.toMatch(/no retry changes that/);
  });
});
