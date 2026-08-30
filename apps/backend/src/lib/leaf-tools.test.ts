import { describe, it, expect } from 'vitest';
import { ToolCallScanner, parseToolArguments, summariseLeaf, detailLeaf } from './leaf-tools.js';
import { ALL_TOOL_SEEDS } from './tool-seeds.js';
import { forSurface } from './tool-catalogue.js';

const LEAF_TOOLS = forSurface(ALL_TOOL_SEEDS, 'planning');
import type { Leaf } from './leaves.js';

const leaf = (over: Partial<Leaf> = {}): Leaf => ({
  id: 'l1', ownerId: 'u1', branchId: 'b1', title: 'Add rate limiting',
  column: 'todo', status: 'pending', depth: 0, blocking: true,
  createdAt: '2026-08-03T00:00:00Z', updatedAt: '2026-08-03T00:00:00Z', ...over,
});

const frame = (delta: unknown) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;

describe('ToolCallScanner', () => {
  it('reassembles a call whose arguments arrive across many deltas', () => {
    const s = new ToolCallScanner();
    s.push(frame({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'list_leaves', arguments: '' } }] }));
    s.push(frame({ tool_calls: [{ index: 0, function: { arguments: '{"sta' } }] }));
    s.push(frame({ tool_calls: [{ index: 0, function: { arguments: 'tus":"failed"}' } }] }));
    expect(s.result()).toEqual([{ id: 'call_1', name: 'list_leaves', arguments: '{"status":"failed"}' }]);
  });

  it('keeps parallel calls separate by index', () => {
    const s = new ToolCallScanner();
    s.push(frame({ tool_calls: [
      { index: 0, id: 'a', function: { name: 'list_leaves', arguments: '{}' } },
      { index: 1, id: 'b', function: { name: 'get_leaf', arguments: '{"id":"x"}' } },
    ] }));
    expect(s.result().map((c) => c.name)).toEqual(['list_leaves', 'get_leaf']);
  });

  it('drops a fragment that never got a name, rather than guessing', () => {
    const s = new ToolCallScanner();
    s.push(frame({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] }));
    expect(s.result()).toEqual([]);
  });

  it('reports nothing for an ordinary content stream', () => {
    const s = new ToolCallScanner();
    s.push(frame({ content: 'just talking' }));
    s.push('data: [DONE]\n\n');
    expect(s.result()).toEqual([]);
  });

  it('survives a frame split mid-JSON', () => {
    const whole = frame({ tool_calls: [{ index: 0, id: 'c', function: { name: 'list_leaves', arguments: '{}' } }] });
    const s = new ToolCallScanner();
    s.push(whole.slice(0, 30));
    s.push(whole.slice(30));
    expect(s.result()).toHaveLength(1);
  });
});

describe('parseToolArguments', () => {
  it('parses an object', () => {
    expect(parseToolArguments('{"status":"failed"}')).toEqual({ status: 'failed' });
  });

  it('returns {} for anything unusable, so a bad blob cannot take down the turn', () => {
    for (const raw of ['', '{oops', 'null', '"a string"', '[1,2]']) {
      expect(parseToolArguments(raw)).toEqual({});
    }
  });
});

describe('tool results', () => {
  it('summarises without the body, which would dominate a list', () => {
    const s = summariseLeaf(leaf({ body: 'A long description.' }));
    expect(s).not.toHaveProperty('body');
    expect(s).toMatchObject({ id: 'l1', title: 'Add rate limiting', status: 'pending' });
  });

  it('reports how many times something failed, without the errors, in a list', () => {
    const s = summariseLeaf(leaf({ attempts: [{ attempt: 0, error: 'boom', failedAt: 'x' }] }));
    expect(s).toMatchObject({ failedAttempts: 1 });
    expect(JSON.stringify(s)).not.toContain('boom');
  });

  it('includes the errors in detail, which is what get_leaf is for', () => {
    const d = detailLeaf(leaf({ body: 'Details.', attempts: [{ attempt: 0, error: 'tests failed', failedAt: 'x' }] }), []);
    expect(d).toMatchObject({ body: 'Details.' });
    expect(JSON.stringify(d)).toContain('tests failed');
    expect((d as any).attempts[0].attempt).toBe(1);
  });

  it('includes sub-leaves so the model can see the shape', () => {
    const d = detailLeaf(leaf(), [leaf({ id: 'kid', title: 'Sub' })]);
    expect((d as any).subLeaves).toHaveLength(1);
  });
});

describe('the planning surface', () => {
  it('covers what a planning turn needs: read, add, revise, withdraw, assign, ingest, and what already exists', () => {
    // Sorted: the surface is a set of rows now, so the order tools are offered in is no longer a
    // property of a hand-written array and nothing depends on it.
    expect(LEAF_TOOLS.map((t) => t.function.name).sort()).toEqual([
      'add_project_dependency', 'create_project', 'fetch_web_page', 'get_leaf', 'ingest_status',
      'list_infrastructure', 'list_leaves', 'list_mcp_servers', 'list_personas', 'list_projects',
      'propose_leaf', 'replace_leaf', 'revise_leaf', 'search_corpus', 'set_acceptance', 'set_leaf_project',
      'start_ingest', 'update_leaf_memory', 'web_search', 'withdraw_leaf',
    ]);
  });

  it('lets only a PROJECT declare a toolchain, never a leaf or a persona', () => {
    expect(LEAF_TOOLS.map((t) => t.function.name)).not.toContain('set_leaf_workspace');
    const takesLanguage = LEAF_TOOLS
      .filter((t) => 'language' in ((t.function.parameters as any)?.properties ?? {}))
      .map((t) => t.function.name);
    expect(takesLanguage).toEqual(['create_project']);
  });

  it('never lets the model name whose project it is', () => {
    for (const name of ['list_projects', 'create_project', 'set_leaf_project']) {
      const params = LEAF_TOOLS.find((t) => t.function.name === name)!.function.parameters as any;
      expect(Object.keys(params.properties ?? {})).not.toContain('ownerId');
      expect(Object.keys(params.properties ?? {})).not.toContain('owner');
      expect(Object.keys(params.properties ?? {})).not.toContain('user');
    }
  });

  it('points at replace_leaf rather than withdraw for a substitution', () => {
    const tool = LEAF_TOOLS.find((t) => t.function.name === 'replace_leaf')!;

    expect(tool.function.description).toMatch(/carrying anything that depends on it/i);
    expect(tool.function.description).toMatch(/silently loses the ordering/i);
  });

  it('asks for the command a USER would type, not a test run', () => {
    const tool = LEAF_TOOLS.find((t) => t.function.name === 'set_acceptance')!;

    const d = tool.function.description;
    expect(d).toMatch(/RUN the thing the way the user described it/i);
    expect(d).toMatch(/test suite alone will happily pass/i);
    expect(d).toMatch(/ASSEMBLED whole/);
    expect(d).toMatch(/Research or writing/i);
    expect(d).toMatch(/source links/i);
  });

  it('does not require a language, so a proposal without one still works', () => {
    const propose = LEAF_TOOLS.find((t) => t.function.name === 'propose_leaf')!;
    expect((propose.function.parameters as { required?: string[] }).required).not.toContain('language');
  });

  it('tells the model editing stops at proposals, so it does not try to rewrite live work', () => {
    for (const name of ['revise_leaf', 'withdraw_leaf']) {
      const tool = LEAF_TOOLS.find((t) => t.function.name === name)!;
      expect(tool.function.description).toMatch(/proposal/i);
    }
  });

  it('says plainly that proposing does not start work', () => {
    const propose = LEAF_TOOLS.find((t) => t.function.name === 'propose_leaf')!;
    expect(propose.function.description).toMatch(/does not start any work/i);
  });

  it('requires only a title to propose, so a bodyless proposal is still valid', () => {
    const propose = LEAF_TOOLS.find((t) => t.function.name === 'propose_leaf')!;
    expect((propose.function.parameters as { required?: string[] }).required).toEqual(['title']);
  });
});

describe('dependency ordering in the tool schema', () => {
  const propose = LEAF_TOOLS.find((t) => t.function.name === 'propose_leaf')!;

  it('lets a proposal say what it must follow', () => {
    const dep = (propose.function.parameters as any).properties.dependsOn;
    expect(dep).toBeDefined();
    expect(dep.type).toBe('array');
    expect(dep.items.type).toBe('string');
  });

  it('asks for titles, not ids, and says why in the description', () => {
    const dep = (propose.function.parameters as any).properties.dependsOn;
    expect(dep.description).toMatch(/titles/i);
    expect(dep.description).not.toMatch(/\bids\b/i);
  });

  it('stays optional, so ordinary independent work needs no ceremony', () => {
    expect((propose.function.parameters as any).required).toEqual(['title']);
  });
});

describe('assigning work to a persona', () => {
  const propose = LEAF_TOOLS.find((t) => t.function.name === 'propose_leaf')!;

  it('lets a proposal name the persona best suited to it', () => {
    const persona = (propose.function.parameters as any).properties.persona;
    expect(persona).toBeDefined();
    expect(persona.type).toBe('string');
  });

  it('asks for a name rather than an id, and says so', () => {
    const persona = (propose.function.parameters as any).properties.persona;
    expect(persona.description).toMatch(/name/i);
    expect(persona.description).not.toMatch(/\bid\b/i);
  });

  it('stays optional, so work with no obvious owner needs no ceremony', () => {
    expect((propose.function.parameters as any).required).toEqual(['title']);
  });

  it('offers a way to find out which personas exist', () => {
    const list = LEAF_TOOLS.find((t) => t.function.name === 'list_personas');
    expect(list).toBeDefined();
    expect(list!.function.description).toMatch(/before assigning/i);
  });
});
