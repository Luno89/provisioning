import { describe, it, expect } from 'vitest';
import { createStoredToolCatalogue } from './tool-catalogue-store.js';
import { BUILDER_TOOLS, type ToolDefinition } from '@koala/agent-engine';
import { ENGINE_TOOL_SEEDS, seedEngineTools } from '../tools/engine-tool-seeds.js';

const store = (rows: ToolDefinition[] = []) => ({
  rows,
  getEngineTools: async () => [...rows],
  saveEngineTool: async (tool: ToolDefinition) => { rows.push(tool); },
});

const catalogue = (rows: ToolDefinition[], include?: ('draft' | 'approved')[]) =>
  createStoredToolCatalogue({
    tools: { list: async () => rows },
    ...(include ? { include } : {}),
  });

describe('the catalogue the engine serves', () => {
  it('always carries the bootstrap four, with nothing in the database', async () => {
    expect(await catalogue([]).names('user-1'))
      .toEqual(BUILDER_TOOLS.map((tool) => tool.name).sort());
  });

  it('withholds a draft from production, and offers it to the harness', async () => {
    const rows = [...ENGINE_TOOL_SEEDS];

    expect(await catalogue(rows).names('user-1'))
      .not.toContain('list_tasks');
    expect(await catalogue(rows, ['draft', 'approved']).names('user-1'))
      .toContain('list_tasks');
  });

  it("lets a user's own row shadow the built-in of the same name", async () => {
    const mine: ToolDefinition = {
      ...ENGINE_TOOL_SEEDS.find((tool) => tool.name === 'list_tasks')!,
      ownerId: 'user-1',
      summary: 'mine',
    };
    const rows = [...ENGINE_TOOL_SEEDS, mine];

    const served = await catalogue(rows, ['draft', 'approved']).list('user-1');
    const listed = served.filter((tool) => tool.name === 'list_tasks');

    expect(listed).toHaveLength(1);
    expect(listed[0]!.summary).toBe('mine');
  });

  it("does not leak one user's tool to another", async () => {
    const mine: ToolDefinition = {
      ...ENGINE_TOOL_SEEDS[0]!,
      name: 'private_thing',
      ownerId: 'user-1',
    };

    expect(await catalogue([mine], ['draft', 'approved']).names('user-2'))
      .not.toContain('private_thing');
  });
});

describe('seeding the catalogue', () => {
  it('writes every seed once and nothing on a second run', async () => {
    const db = store();

    expect(await seedEngineTools(db)).toBe(ENGINE_TOOL_SEEDS.length);
    expect(await seedEngineTools(db)).toBe(0);
  });

  it('refuses a declaration nothing implements, rather than letting it refuse at dispatch', async () => {
    await expect(seedEngineTools(store(), { implemented: new Set(['start_task']) }))
      .rejects.toThrow(/declared but nothing implements it/);
  });

  it('accepts the seeds when the handlers are there', async () => {
    const implemented = new Set(ENGINE_TOOL_SEEDS.map((tool) => tool.name));

    await expect(seedEngineTools(store(), { implemented })).resolves.toBe(ENGINE_TOOL_SEEDS.length);
  });
});
