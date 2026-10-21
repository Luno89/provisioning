import { describe, it, expect, vi } from 'vitest';
import { type Persona } from '@koala/agent-engine';
import { MemoryDB } from '../lib/memory-db.js';
import { directoryFromDatabase } from '../engine-host/registries/agent-directory.js';
import { ENGINE_TOOL_SEEDS } from '../engine-host/tools/engine-tool-seeds.js';
import { AgentService, agentProblems } from './AgentService.js';
import type { ImageStanding } from '../engine-host/sandboxes/image-builder.js';
import { seededAgents, seededProcedures } from '../extensions/seeds.js';
import type { McpServerRecord, ServerRuns } from '../lib/mcp-servers.js';

const tools = () => [...ENGINE_TOOL_SEEDS];
const PROCEDURES = seededProcedures();
const AGENTS = new Set(seededAgents().map((agent) => agent.slug));

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

function service(over: { image?: ImageStanding; treeTypes?: { id: string; label: string; agent?: string }[]; servers?: McpServerRecord[] } = {}) {
  const db = new MemoryDB();
  const stored = () => db.getEnginePersonas();
  const started: string[] = [];

  const images = {
    start: vi.fn(async (plan: { fingerprint: string }) => {
      started.push(plan.fingerprint);
      return over.image ?? { state: 'building' as const, reference: 'registry/koala:abc' };
    }),
    standing: vi.fn(async () => over.image ?? { state: 'ready' as const, reference: 'registry/koala:abc' }),
  };

  return {
    db,
    stored,
    started,
    images,
    agents: new AgentService({
      agents: directoryFromDatabase(db),
      records: {
        save: (record) => db.saveEnginePersona(record),
        remove: (ownerId, slug) => db.deleteEnginePersona(ownerId, slug),
      },
      tools: async () => tools(),
      procedures: async () => [...PROCEDURES],
      treeTypes: async () => over.treeTypes ?? [],
      ...(over.servers ? { servers: async () => over.servers! } : {}),
      images,
    }),
  };
}

describe('file tools for an agent that works in a shared workspace', () => {
  const finder = agent({ slug: 'finder', tools: ['read_file'], environment: { filesystem: true } });
  const talker = (agents: string[]) => agent({ slug: 'talker', tools: ['read_file'], environment: {}, agents });

  it('allows them when someone it can hand work to, however far down, works in a sandbox it will share', () => {
    const middle = agent({ slug: 'middle', tools: [], environment: {}, agents: ['finder'] });
    const personas = [finder, middle];

    expect(agentProblems(talker(['finder']), { ...known(), agents: new Set(['finder', 'middle']), personas })).toEqual([]);
    expect(agentProblems(talker(['middle']), { ...known(), agents: new Set(['finder', 'middle']), personas })).toEqual([]);
  });

  it('refuses them when nothing it can reach works in a sandbox', () => {
    const idle = agent({ slug: 'idle', tools: [], environment: {} });

    expect(agentProblems(talker(['idle']), { ...known(), agents: new Set(['idle']), personas: [idle] }).join('\n')).toContain('"read_file", which cannot run in the workspace it asks for');
  });
});

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

  it('may only hold MCP servers in the person\'s catalogue', () => {
    expect(agentProblems(agent({ servers: ['gitea'] }), { ...known(), servers: ['gitea'] })).toEqual([]);
    expect(agentProblems(agent({ servers: ['jira'] }), { ...known(), servers: ['gitea'] }))
      .toContain('it holds "jira", which is not one of your MCP servers');
  });

  it('cannot be granted a tool above the limit it is held to', () => {
    expect(agentProblems(agent({ maxEffect: 'read' }), known())).toEqual([]);
    expect(agentProblems(agent({ maxEffect: 'read', tools: ['read_file', 'write_file'] }), known()))
      .toContain('it is granted "write_file", which can change things, but the agent is limited to reading');
    expect(agentProblems(agent({ maxEffect: 'nothing' as never }), known()))
      .toContain('"nothing" is not a limit — an agent may be limited to read, propose or write');
  });

  it('concludes a conversation only after a positive number of quiet minutes', () => {
    expect(agentProblems(agent({ concludeAfterMinutes: 25 }), known())).toEqual([]);
    expect(agentProblems(agent({ concludeAfterMinutes: 0 }), known())).toContain('a conversation concludes after a number of quiet minutes greater than zero; leave it blank for the default');
    expect(agentProblems(agent({ concludeAfterMinutes: 'soon' as never }), known())).toHaveLength(1);
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
      tools: ['start_task', 'task_status', 'mark_done', 'mark_failed', 'run_command'],
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

    const outcome = await agents.save('user-1', { ...seededAgents().find((one) => one.slug === 'research')!, prompt: 'You dig, differently.' });

    expect(outcome).toMatchObject({ saved: true, agent: { slug: 'research', mine: true } });
    expect(await stored()).toHaveLength(1);

    const listed = await agents.list('user-1');
    expect(listed.filter((one) => one.slug === 'research')).toHaveLength(1);
    expect(listed.find((one) => one.slug === 'research')).toMatchObject({ mine: true, prompt: 'You dig, differently.' });
  });

  it('leaves the built-in alone for everybody else', async () => {
    const { agents } = service();
    await agents.save('user-1', { ...seededAgents().find((one) => one.slug === 'research')!, prompt: 'Mine.' });

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

  it('gives an agent a server, keeping what it held, and starts its image with the server in it', async () => {
    const runs: ServerRuns = { where: 'workspace', needs: ['jq'], start: 'echoes', port: 8931 };
    const echoes: McpServerRecord = { id: 's1', ownerId: 'user-1', name: 'echoes', runs, createdAt: 't', updatedAt: 't' };
    const { agents, images } = service({ servers: [echoes] });
    await agents.save('user-1', agent({ tools: ['run_command', 'read_file'] }));
    images.start.mockClear();

    const image = await agents.holdServer('user-1', 'digger', 'echoes', { why: 'echo things', proposalId: 'a1' });

    expect(image).toEqual({ state: 'building', reference: 'registry/koala:abc' });
    expect(images.start).toHaveBeenCalledOnce();
    expect(images.start.mock.calls[0]![0]).toMatchObject({ lines: expect.arrayContaining([expect.objectContaining({ from: 'server:echoes' })]) });
    expect((await agents.get('user-1', 'digger'))?.servers).toEqual(['echoes']);
    expect(await agents.image('user-1', 'digger')).toEqual({ state: 'ready', reference: 'registry/koala:abc' });
    await expect(agents.holdServer('user-1', 'ghost', 'echoes')).rejects.toThrow('there is no agent called ghost');
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
    expect(await stored()).toEqual([]);
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
    await agents.save('user-1', { ...seededAgents().find((one) => one.slug === 'research')!, prompt: 'Mine.' });

    expect(await agents.remove('user-1', 'research')).toBe(true);
    expect((await agents.get('user-1', 'research'))?.mine).toBe(false);
  });

  it('stores an agent without its tools: what it holds is its grants, and a built-in keeps what ships', async () => {
    const { agents, db, stored } = service();
    const research = seededAgents().find((one) => one.slug === 'research')!;
    const [first, ...rest] = research.tools;

    await agents.save('user-1', { ...research, prompt: 'Mine.', tools: [...rest, 'run_command'] });

    expect(await stored()).toHaveLength(1);
    expect((await stored()).some((one) => 'tools' in one)).toBe(false);
    expect((await agents.get('user-1', 'research'))?.tools).toEqual([...rest, 'run_command']);
    expect((await agents.get('user-1', 'research'))?.toolSources).toEqual([
      { tool: first, source: 'revoked' },
      ...rest.map((tool) => ({ tool, source: 'shipped' })),
      { tool: 'run_command', source: 'granted' },
    ]);
    expect((await db.getToolGrants('user-1')).map((grant) => [grant.tool, grant.revoked === true])).toEqual([['run_command', false], [first, true]]);
    expect((await agents.get('user-2', 'research'))?.tools).toEqual(research.tools);
  });

  it('changes only the grants of a built-in whose tools are all that changed, so it stays built in', async () => {
    const { agents, stored } = service();
    const research = seededAgents().find((one) => one.slug === 'research')!;

    const outcome = await agents.save('user-1', { ...research, tools: [...research.tools, 'run_command'] });

    expect(outcome).toMatchObject({ saved: true, agent: { slug: 'research', mine: false, tools: [...research.tools, 'run_command'] } });
    expect(await stored()).toEqual([]);
    expect((await agents.get('user-1', 'research'))?.prompt).toBe(research.prompt);
  });

  it('gives a built-in its shipped tools back when your copy of it is deleted', async () => {
    const { agents, db } = service();
    const research = seededAgents().find((one) => one.slug === 'research')!;
    await agents.save('user-1', { ...research, prompt: 'Mine.', tools: ['run_command'] });

    expect(await agents.remove('user-1', 'research')).toBe(true);
    expect((await agents.get('user-1', 'research'))?.tools).toEqual(research.tools);
    expect(await db.getToolGrants('user-1')).toEqual([]);
  });

  it('will not delete a built-in, because it was never yours', async () => {
    const { agents } = service();

    expect(await agents.remove('user-1', 'research')).toBe(false);
  });
});

describe('whether an agent recalls memories', () => {
  it('says so when its procedure has a Recall memory step, inside groups too, and not otherwise', async () => {
    const listed = await service().agents.list('user-1');
    expect(listed.find((one) => one.slug === 'koala')?.recallsMemories).toBe(true);
    expect(listed.find((one) => one.slug === 'research')?.recallsMemories).toBe(true);
    expect(listed.find((one) => one.slug === 'grove')?.recallsMemories).toBe(false);
  });
});

describe('how an agent is used', () => {
  it('lists each agent with what uses it, including the tree types that grow with it', async () => {
    const { agents } = service({ treeTypes: [{ id: 'default', label: 'Default' }] });
    const listed = await agents.list('user-1');

    expect(listed.find((one) => one.slug === 'koala')?.usedBy).toContainEqual({ kind: 'chat', by: 'every new conversation' });
    expect(listed.find((one) => one.slug === 'memory-keeper')?.usedBy).toContainEqual(expect.objectContaining({ kind: 'platform' }));
    expect(listed.find((one) => one.slug === 'grove')?.usedBy).toContainEqual({ kind: 'tree-type', by: 'Default' });
    expect(listed.find((one) => one.slug === 'research')?.usedBy).toContainEqual({ kind: 'hand-off', by: 'koala' });
  });
});
