import { describe, it, expect, vi } from 'vitest';
import { EngineToolService, toolProblems } from './EngineToolService.js';
import type { Persona, ToolDefinition } from '@koala/agent-engine';

const tool = (over: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name: 'count_lines',
  summary: 'Counts the lines that match',
  binding: 'environment',
  effect: 'read',
  idempotent: false,
  openWorld: false,
  returns: 'the number of matching lines',
  failures: [{ when: 'the path does not exist', says: 'no such file' }],
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'what to look for' },
      path: { type: 'string', description: 'where to look' },
    },
  },
  command: 'rg --count {pattern} {path}',
  needsBinaries: ['rg'],
  install: { via: 'dnf', packages: ['ripgrep'] },
  ...over,
});

const persona = (over: Partial<Persona> = {}): Persona => ({
  slug: 'executor',
  name: 'Executor',
  description: 'Does one task',
  version: '1',
  prompt: 'You do one thing.',
  guidance: '',
  returns: '',
  failures: [],
  procedure: 'tool-rounds',
  tools: ['count_lines'],
  environment: { terminal: true, filesystem: true },
  ...over,
});

const IMPLEMENTED = new Set(['run_command', 'read_file']);

function setup(over: { stored?: ToolDefinition[]; personas?: Persona[]; builtIn?: Persona[]; images?: 'building' | 'unreachable' | 'reported' } = {}) {
  const stored = [...(over.stored ?? [])];
  const start = vi.fn(async () => {
    if (over.images === 'unreachable') throw new Error('Could not find the image registry (gitea-http in gitea)');
    if (over.images === 'reported') return { state: 'failed' as const, reference: '', detail: 'no such package' };
    return { state: 'building' as const, reference: 'registry/koala:abc' };
  });

  return {
    stored,
    start,
    tools: new EngineToolService({
      tools: {
        list: async () => [...stored],
        save: async (saved: ToolDefinition) => {
          const at = stored.findIndex((row) => row.name === saved.name && row.ownerId === saved.ownerId);
          if (at === -1) stored.push(saved); else stored[at] = saved;
        },
        remove: async (ownerId: string | undefined, name: string) => {
          const at = stored.findIndex((row) => row.name === name && row.ownerId === ownerId);
          if (at !== -1) stored.splice(at, 1);
        },
      },
      personas: { list: async () => over.personas ?? [] },
      builtInAgents: over.builtIn ?? [],
      implemented: IMPLEMENTED,
      images: { start },
    }),
  };
}

describe('what a tool is refused for', () => {
  it('accepts a whole one', () => {
    expect(toolProblems(tool(), { implemented: IMPLEMENTED })).toEqual([]);
  });

  it('needs a command when nothing here already runs a tool of that name', () => {
    expect(toolProblems(tool({ command: undefined, needsBinaries: undefined, install: undefined }), { implemented: IMPLEMENTED }))
      .toContain('nothing here runs this tool, so it needs a command to run in the workspace');
  });

  it('lets a copy of a built-in stand without a command, because one already runs it', () => {
    const copy = tool({ name: 'read_file', command: undefined, needsBinaries: undefined, install: undefined });

    expect(toolProblems(copy, { implemented: IMPLEMENTED })).toEqual([]);
  });

  it('refuses a command that fills in an argument the tool does not take', () => {
    expect(toolProblems(tool({ command: 'rg --count {pattern} {nowhere}' }), { implemented: IMPLEMENTED }))
      .toContain('its command fills in "nowhere", which it does not take as an argument');
  });

  it('refuses a command on a tool that has no workspace to run it in', () => {
    const problems = toolProblems(tool({ binding: 'network', needsBinaries: undefined, install: undefined }), { implemented: IMPLEMENTED });

    expect(problems.join(' ')).toContain('only an environment-bound tool can run a command');
  });

  it('refuses an install that names no packages, and a script that is empty', () => {
    expect(toolProblems(tool({ install: { via: 'dnf', packages: [] } }), { implemented: IMPLEMENTED }))
      .toContain('the install names no packages, so it would install nothing');
    expect(toolProblems(tool({ install: { via: 'script', run: '  ' } }), { implemented: IMPLEMENTED }))
      .toContain('the install script is empty, so it would install nothing');
  });

  it('takes a script install when it says which binary it gives', () => {
    const scripted = tool({ needsBinaries: ['gh'], install: { via: 'script', run: 'curl -fsSL https://example.com/gh | sh' } });

    expect(toolProblems(scripted, { implemented: IMPLEMENTED })).toEqual([]);
  });

  it('refuses an install that never says what binary it provides', () => {
    expect(toolProblems(tool({ needsBinaries: [], install: { via: 'dnf', packages: ['ripgrep'] } }), { implemented: IMPLEMENTED }))
      .toContain('it installs something but never says which binary that gives it');
  });

  it('refuses a binary with no way to install it', () => {
    expect(toolProblems(tool({ install: undefined }), { implemented: IMPLEMENTED }).join(' '))
      .toContain('does not say how to install it');
  });
});

describe('the tools a person can edit', () => {
  it('says which are theirs and which agents were granted them', async () => {
    const { tools } = setup({
      stored: [tool({ ownerId: undefined }), tool({ name: 'read_file', ownerId: 'user-1', command: undefined, needsBinaries: undefined, install: undefined })],
      personas: [persona()],
    });

    const listed = await tools.list('user-1');

    expect(listed.map((one) => [one.name, one.mine, one.grantedTo])).toEqual([
      ['count_lines', false, ['executor']],
      ['read_file', true, []],
    ]);
  });

  it('counts the built-in agents that hold a tool, unless the person\'s own copy of that agent dropped it', async () => {
    const builtIn = [persona({ slug: 'koala', tools: ['count_lines'] }), persona({ slug: 'research', tools: ['count_lines'] })];
    const { tools } = setup({ stored: [tool({ ownerId: undefined })], builtIn, personas: [persona({ slug: 'research', ownerId: 'user-1', tools: [] })] });

    expect((await tools.list('user-1')).find((one) => one.name === 'count_lines')?.grantedTo).toEqual(['koala']);
  });

  it('saves a tool as the owner’s own', async () => {
    const { tools, stored } = setup();

    const outcome = await tools.save('user-1', tool());

    expect(outcome).toMatchObject({ saved: true });
    expect(stored[0]).toMatchObject({ name: 'count_lines', ownerId: 'user-1' });
  });

  it('refuses to save one that does not hold together, and stores nothing', async () => {
    const { tools, stored } = setup();

    const outcome = await tools.save('user-1', tool({ command: '' }));

    expect(outcome).toMatchObject({ saved: false });
    expect(stored).toEqual([]);
  });

  it('rebuilds the workspace of every agent granted the tool it just changed', async () => {
    const { tools, start } = setup({ stored: [tool({ ownerId: undefined })], personas: [persona(), persona({ slug: 'judge', tools: [] })] });

    const outcome = await tools.save('user-1', tool({ install: { via: 'dnf', packages: ['ripgrep', 'jq'] } }));

    expect(start).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ saved: true, rebuilding: ['executor'] });
  });

  it('says which workspaces could not start building, rather than only which did', async () => {
    const { tools } = setup({
      stored: [tool({ ownerId: undefined })],
      personas: [persona(), persona({ slug: 'judge' })],
      images: 'unreachable',
    });

    const outcome = await tools.save('user-1', tool({ install: { via: 'dnf', packages: ['ripgrep'] } }));

    expect(outcome).toMatchObject({
      saved: true,
      rebuilding: [],
      failed: [
        { agent: 'executor', detail: 'Could not find the image registry (gitea-http in gitea)' },
        { agent: 'judge', detail: 'Could not find the image registry (gitea-http in gitea)' },
      ],
    });
  });

  it('passes on a build that reported itself failed, so the person hears it at the save', async () => {
    const { tools } = setup({ stored: [tool({ ownerId: undefined })], personas: [persona()], images: 'reported' });

    const outcome = await tools.save('user-1', tool({ install: { via: 'dnf', packages: ['ripgrep'] } }));

    expect(outcome).toMatchObject({
      saved: true,
      rebuilding: [],
      failed: [{ agent: 'executor', detail: 'no such package' }],
    });
  });

  it('only deletes a tool of your own', async () => {
    const { tools } = setup({ stored: [tool({ ownerId: undefined })] });

    expect(await tools.remove('user-1', 'count_lines')).toBe(false);
  });

  it('deletes your copy and leaves the built-in standing', async () => {
    const { tools, stored } = setup({ stored: [tool({ ownerId: undefined }), tool({ ownerId: 'user-1' })] });

    expect(await tools.remove('user-1', 'count_lines')).toBe(true);
    expect(stored.map((one) => one.ownerId)).toEqual([undefined]);
  });
});

describe('the tools page and an agent\'s grants read one catalogue', () => {
  it('lists every tool an agent can be granted, the bootstrap ones too', async () => {
    const { BUILDER_TOOLS } = await import('@koala/agent-engine');
    const { createStoredToolCatalogue } = await import('../engine-host/registries/tool-catalogue-store.js');
    const stored = [tool({ ownerId: undefined })];
    const tools = new EngineToolService({
      tools: { list: async () => stored, save: async () => undefined, remove: async () => undefined },
      catalogue: createStoredToolCatalogue({ tools: { list: async () => stored } }),
      personas: { list: async () => [] },
      builtInAgents: [],
      implemented: IMPLEMENTED,
    });

    expect((await tools.list('user-1')).map((one) => one.name)).toEqual([...BUILDER_TOOLS.map((one) => one.name), 'count_lines'].sort());
  });
});
