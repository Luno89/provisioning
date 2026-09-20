import { describe, it, expect, vi } from 'vitest';
import { ALL_SEEDED_AGENTS, type Persona } from '@koala/agent-engine';
import { ENGINE_TOOL_SEEDS } from '../engine-host/tools/engine-tool-seeds.js';
import { AgentService, agentProblems } from './AgentService.js';
import type { ImageStanding } from '../engine-host/sandboxes/image-builder.js';
import { BUILT_IN_PROCEDURES } from '@koala/agent-engine/procedure';

const tools = () => [...ENGINE_TOOL_SEEDS];
const PROCEDURES = BUILT_IN_PROCEDURES;
const AGENTS = new Set(ALL_SEEDED_AGENTS().map((agent) => agent.slug));

const agent = (over: Partial<Persona> = {}): Persona => ({
  slug: 'digger',
  name: 'Digger',
  description: 'Digs things up',
  version: '1',
  prompt: 'You dig.',
  guidance: '',
  returns: '',
  failures: [],
  procedure: 'tool-rounds',
  tools: ['read_file', 'list_dir'],
  environment: { terminal: true, filesystem: true },
  ...over,
});

const known = () => ({ tools: tools(), procedures: PROCEDURES, agents: AGENTS });

function service(over: { stored?: Persona[]; image?: ImageStanding } = {}) {
  const stored = [...(over.stored ?? [])];
  const started: string[] = [];

  const images = {
    start: vi.fn(async (plan: { fingerprint: string }) => {
      started.push(plan.fingerprint);
      return over.image ?? { state: 'building' as const, reference: 'registry/koala:abc' };
    }),
    standing: vi.fn(async () => over.image ?? { state: 'ready' as const, reference: 'registry/koala:abc' }),
  };

  return {
    stored,
    started,
    images,
    agents: new AgentService({
      personas: {
        list: async () => [...stored],
        save: async (persona: Persona) => {
          const at = stored.findIndex((row) => row.slug === persona.slug && row.ownerId === persona.ownerId);
          if (at === -1) stored.push(persona); else stored[at] = persona;
        },
        remove: async (ownerId: string | undefined, slug: string) => {
          const at = stored.findIndex((row) => row.slug === slug && row.ownerId === ownerId);
          if (at !== -1) stored.splice(at, 1);
        },
      },
      tools: async () => tools(),
      procedures: async () => [...PROCEDURES],
      images,
    }),
  };
}

describe('what an agent is refused for', () => {
  it('accepts a whole one', () => {
    expect(agentProblems(agent(), known())).toEqual([]);
  });

  it('needs a slug it can be addressed by', () => {
    expect(agentProblems(agent({ slug: 'Not A Slug' }), known()))
      .toContain('the slug has to be lower-case words joined by dashes');
  });

  it('needs a prompt, a name and something it is for', () => {
    const problems = agentProblems({ slug: 'bare' }, known());

    expect(problems).toContain('the agent needs a name');
    expect(problems).toContain('the agent has to say what it is for');
    expect(problems).toContain('the agent needs a prompt');
  });

  it('has to name a procedure that exists', () => {
    expect(agentProblems(agent({ procedure: 'ghost' }), known())).toContain('there is no procedure called "ghost"');
  });

  it('cannot be granted a tool that is not one', () => {
    expect(agentProblems(agent({ tools: ['read_file', 'ghost_tool'] }), known()))
      .toContain('it is granted "ghost_tool", which is not a tool');
  });

  it('cannot hand work to an agent that does not exist, or to itself', () => {
    expect(agentProblems(agent({ agents: ['nobody'] }), known()))
      .toContain('it may hand work to "nobody", which is not an agent');
    expect(agentProblems(agent({ agents: ['digger'] }), known()))
      .toContain('an agent cannot hand work to itself');
  });

  it('can only ask for a language the workspace knows how to get', () => {
    expect(agentProblems(agent({ environment: { terminal: true, filesystem: true, languages: ['cobol'] } }), known()).join(' '))
      .toContain('"cobol" is not a language a workspace can ask for — it can ask for node, python, go');
    expect(agentProblems(agent({ environment: { terminal: true, filesystem: true, languages: ['node', 'go'] } }), known())).toEqual([]);
  });

  it('refuses one that is missing a grant the procedure it runs needs, and says why', () => {
    const problems = agentProblems(
      agent({ procedure: 'do-one-task', tools: ['run_command', 'start_task'], agents: [] }),
      known(),
    );

    expect(problems).toContain('do-one-task needs it to have the tool "mark_done" — The outcome is then recorded on the task for you. Do not record it yourself.');
    expect(problems).toContain('do-one-task needs it to have the agent "judge" — When you finish, a judge weighs your work against what the task asked for. You do not have to ask it yourself.');
  });

  it('accepts one that is granted everything its procedure drives', () => {
    const whole = agent({
      procedure: 'do-one-task',
      tools: ['start_task', 'mark_done', 'mark_failed', 'run_command'],
      agents: ['judge'],
      environment: { terminal: true, filesystem: true },
    });

    expect(agentProblems(whole, known())).toEqual([]);
  });

  it('asks nothing extra of a procedure that only lets the model choose', () => {
    expect(agentProblems(agent({ procedure: 'tool-rounds', tools: [], agents: [] }), known())).toEqual([]);
  });

  it('refuses a tool the workspace it asks for could never run', () => {
    const problems = agentProblems(agent({ tools: ['run_command'], environment: {} }), known());

    expect(problems.join(' ')).toContain('cannot run in the workspace it asks for');
  });

  it('refuses a reply ceiling that is not a number of tokens', () => {
    expect(agentProblems(agent({ model: { replyCeiling: 10 } }), known()).join(' ')).toContain('at least 256 tokens');
  });
});

describe('agents you can edit', () => {
  it('lists the built-ins as not yours, and shows what image each needs', async () => {
    const { agents } = service();
    const listed = await agents.list('user-1');

    expect(listed.every((one) => one.mine === false)).toBe(true);
    expect(listed.find((one) => one.slug === 'executor')?.image).toMatchObject({ state: 'ready' });
    expect(listed.find((one) => one.slug === 'koala')?.image).toBeUndefined();
  });

  it('saves your own copy and shadows the built-in by slug', async () => {
    const { agents, stored } = service();

    const outcome = await agents.save('user-1', { ...ALL_SEEDED_AGENTS().find((one) => one.slug === 'research')!, prompt: 'You dig, differently.' });

    expect(outcome).toMatchObject({ saved: true, agent: { slug: 'research', mine: true } });
    expect(stored).toHaveLength(1);

    const listed = await agents.list('user-1');
    expect(listed.filter((one) => one.slug === 'research')).toHaveLength(1);
    expect(listed.find((one) => one.slug === 'research')).toMatchObject({ mine: true, prompt: 'You dig, differently.' });
  });

  it('leaves the built-in alone for everybody else', async () => {
    const { agents } = service();
    await agents.save('user-1', { ...ALL_SEEDED_AGENTS().find((one) => one.slug === 'research')!, prompt: 'Mine.' });

    expect((await agents.get('user-2', 'research'))?.prompt).not.toBe('Mine.');
    expect((await agents.get('user-2', 'research'))?.mine).toBe(false);
  });

  it('saves a brand new agent against any procedure that exists', async () => {
    const { agents } = service();

    const outcome = await agents.save('user-1', agent());

    expect(outcome).toMatchObject({ saved: true });
    expect((await agents.get('user-1', 'digger'))?.mine).toBe(true);
  });

  it('starts the workspace image when the grants are saved', async () => {
    const { agents, started, images } = service({ image: { state: 'building', reference: 'registry/koala:abc' } });

    const outcome = await agents.save('user-1', agent({ tools: ['run_command', 'read_file'] }));

    expect(images.start).toHaveBeenCalledOnce();
    expect(started).toHaveLength(1);
    expect(outcome).toMatchObject({ saved: true, agent: { image: { state: 'building' } } });
  });

  it('starts no image for an agent that needs no machine', async () => {
    const { agents, images } = service();

    await agents.save('user-1', agent({ tools: ['search_web'], environment: { egress: true } }));

    expect(images.start).not.toHaveBeenCalled();
  });

  it('saves nothing when it does not hold together', async () => {
    const { agents, stored } = service();

    const outcome = await agents.save('user-1', agent({ procedure: 'ghost' }));

    expect(outcome).toMatchObject({ saved: false });
    expect(stored).toEqual([]);
  });

  it('says an image that could not be started failed, rather than refusing the save', async () => {
    const { agents } = service();
    const failing = service();
    failing.images.start.mockRejectedValueOnce(new Error('the registry is not up'));

    const outcome = await failing.agents.save('user-1', agent());

    expect(outcome).toMatchObject({ saved: true, agent: { image: { state: 'failed', detail: 'the registry is not up' } } });
    expect(await agents.get('user-1', 'digger')).toBeUndefined();
  });

  it('deletes only your own copy, and the built-in comes back', async () => {
    const { agents } = service();
    await agents.save('user-1', { ...ALL_SEEDED_AGENTS().find((one) => one.slug === 'research')!, prompt: 'Mine.' });

    expect(await agents.remove('user-1', 'research')).toBe(true);
    expect((await agents.get('user-1', 'research'))?.mine).toBe(false);
  });

  it('will not delete a built-in, because it was never yours', async () => {
    const { agents } = service();

    expect(await agents.remove('user-1', 'research')).toBe(false);
  });
});
