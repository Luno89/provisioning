import { describe, it, expect } from 'vitest';
import axios from 'axios';
import type { ToolDefinition } from '@koala/agent-engine';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import { engineToolsRouter } from './engine-tools.js';
import { EngineToolService } from '../services/EngineToolService.js';
import { ENGINE_TOOL_SEEDS } from '../engine-host/tools/engine-tool-seeds.js';

const quiet = { validateStatus: () => true };

const counter = (over: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name: 'count_lines',
  summary: 'Counts the lines that match',
  binding: 'environment',
  effect: 'read',
  status: 'draft',
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

const harness = (): Promise<Harness> => mountRouter({
  prefix: '/api/engine-tools',
  router: (db) => engineToolsRouter({
    tools: new EngineToolService({
      tools: {
        list: (ownerId?: string) => db.getEngineTools(ownerId),
        save: (tool) => db.saveEngineTool(tool),
        remove: (ownerId, name) => db.deleteEngineTool(ownerId, name),
      },
      personas: { list: (ownerId?: string) => db.getEnginePersonas(ownerId) },
      implemented: new Set(ENGINE_TOOL_SEEDS.map((tool) => tool.name)),
      images: { start: async () => ({ state: 'building', reference: 'registry/koala:abc' }) },
    }),
  }),
});

describe('the engine tools API', () => {
  it('lists the tools a person can see', async () => {
    const { url, close } = await harness();
    const { data } = await axios.get(url('/api/engine-tools'));
    await close();

    expect(Array.isArray(data.tools)).toBe(true);
  });

  it('saves a tool of your own, with the command that runs it', async () => {
    const { url, close } = await harness();

    const saved = await axios.put(url('/api/engine-tools/count_lines'), counter());
    const read = await axios.get(url('/api/engine-tools/count_lines'));
    await close();

    expect(saved.status).toBe(200);
    expect(saved.data.tool).toMatchObject({ name: 'count_lines', mine: true, ownerId: TEST_USER.id });
    expect(read.data.tool.command).toBe('rg --count {pattern} {path}');
  });

  it('refuses one whose command fills in an argument it does not take', async () => {
    const { url, close } = await harness();

    const out = await axios.put(url('/api/engine-tools/count_lines'), counter({ command: 'rg {nowhere}' }), quiet);
    await close();

    expect(out.status).toBe(400);
    expect(out.data.problems.join(' ')).toContain('"nowhere"');
  });

  it('refuses a body whose name is not the one in the path', async () => {
    const { url, close } = await harness();

    const out = await axios.put(url('/api/engine-tools/count_lines'), counter({ name: 'other' }), quiet);
    await close();

    expect(out.status).toBe(400);
  });

  it('has nothing to delete when the tool is not yours', async () => {
    const { url, close } = await harness();

    const out = await axios.delete(url('/api/engine-tools/read_file'), quiet);
    await close();

    expect(out.status).toBe(404);
  });

  it('deletes a tool you saved', async () => {
    const { url, close } = await harness();

    await axios.put(url('/api/engine-tools/count_lines'), counter());
    const gone = await axios.delete(url('/api/engine-tools/count_lines'), quiet);
    const after = await axios.get(url('/api/engine-tools/count_lines'), quiet);
    await close();

    expect(gone.status).toBe(200);
    expect(after.status).toBe(404);
  });
});
