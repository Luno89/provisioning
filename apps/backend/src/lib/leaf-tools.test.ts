import { describe, it, expect } from 'vitest';
import { ToolCallScanner, parseToolArguments, summariseLeaf, detailLeaf, LEAF_TOOLS } from './leaf-tools.js';
import type { Leaf } from './leaves.js';
import { WORKSPACE_IMAGES } from './workspace-spec.js';

const leaf = (over: Partial<Leaf> = {}): Leaf => ({
  id: 'l1', ownerId: 'u1', branchId: 'b1', title: 'Add rate limiting',
  column: 'todo', status: 'pending', depth: 0, blocking: true,
  createdAt: '2026-08-03T00:00:00Z', updatedAt: '2026-08-03T00:00:00Z', ...over,
});

const frame = (delta: unknown) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;

describe('ToolCallScanner', () => {
  it('reassembles a call whose arguments arrive across many deltas', () => {
    // The real shape: name on the first delta, arguments a character at a time after it. Reading
    // only the first gives a call with empty arguments that then runs with defaults, looking like
    // the model asked for something it never did.
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
    // Arguments are model output. A malformed one should run with defaults or report a clear
    // error, never throw out of the request.
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
    // Attempts are 1-based for the model, matching how they read to a human.
    expect((d as any).attempts[0].attempt).toBe(1);
  });

  it('includes sub-leaves so the model can see the shape', () => {
    const d = detailLeaf(leaf(), [leaf({ id: 'kid', title: 'Sub' })]);
    expect((d as any).subLeaves).toHaveLength(1);
  });
});

describe('LEAF_TOOLS', () => {
  it('covers what a planning turn needs: read, add, revise, withdraw, toolchain, repository', () => {
    expect(LEAF_TOOLS.map((t) => t.function.name)).toEqual([
      'list_leaves', 'get_leaf', 'propose_leaf', 'revise_leaf', 'withdraw_leaf', 'set_leaf_workspace',
      'list_projects', 'create_project', 'set_leaf_project',
      'list_tool_repository', 'attach_tool_to_leaf', 'update_leaf_memory', 'web_search', 'fetch_web_page',
    ]);
  });

  it('never lets the model name whose project it is', () => {
    // Ownership comes from the session. A tool taking an owner/user argument would let a prompt
    // ("register this under admin") reach across tenants — so no such parameter exists.
    for (const name of ['list_projects', 'create_project', 'set_leaf_project']) {
      const params = LEAF_TOOLS.find((t) => t.function.name === name)!.function.parameters as any;
      expect(Object.keys(params.properties ?? {})).not.toContain('ownerId');
      expect(Object.keys(params.properties ?? {})).not.toContain('owner');
      expect(Object.keys(params.properties ?? {})).not.toContain('user');
    }
  });

  it('puts the whole image catalogue in the schema, so choosing costs no tool round', () => {
    // A `list_workspace_options` tool would spend one of only MAX_TOOL_ROUNDS inference passes to
    // learn a fixed list.
    for (const name of ['propose_leaf', 'set_leaf_workspace']) {
      const params = LEAF_TOOLS.find((t) => t.function.name === name)!.function.parameters as any;
      expect(params.properties.language.enum).toEqual(Object.keys(WORKSPACE_IMAGES));
      // Each option says what it contains, or the enum is just four opaque words.
      for (const entry of Object.values(WORKSPACE_IMAGES)) {
        expect(params.properties.language.description).toContain(entry.summary);
      }
    }
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
    // Without this the model tells the user it has started something it has not.
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
    // Without this the model has no way to express order at all, so a five-step plan fans out and
    // every step after the first runs against an empty sandbox.
    const dep = (propose.function.parameters as any).properties.dependsOn;
    expect(dep).toBeDefined();
    expect(dep.type).toBe('array');
    expect(dep.items.type).toBe('string');
  });

  it('asks for titles, not ids, and says why in the description', () => {
    // The model proposes several leaves in one turn and cannot know the ids of the ones it just
    // created — asking for ids would get guesses.
    const dep = (propose.function.parameters as any).properties.dependsOn;
    expect(dep.description).toMatch(/titles/i);
    expect(dep.description).not.toMatch(/\bids\b/i);
  });

  it('stays optional, so ordinary independent work needs no ceremony', () => {
    expect((propose.function.parameters as any).required).toEqual(['title']);
  });
});
