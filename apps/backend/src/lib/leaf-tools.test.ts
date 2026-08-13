import { describe, it, expect } from 'vitest';
import { ToolCallScanner, parseToolArguments, summariseLeaf, detailLeaf, LEAF_TOOLS } from './leaf-tools.js';
import type { Leaf } from './leaves.js';

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
  it('covers what a planning turn needs: read, add, revise, withdraw, assign, ingest, repository', () => {
    expect(LEAF_TOOLS.map((t) => t.function.name)).toEqual([
      'list_leaves', 'get_leaf', 'propose_leaf', 'set_acceptance', 'revise_leaf', 'replace_leaf', 'withdraw_leaf',
      'start_ingest', 'ingest_status', 'search_corpus',
      'list_personas',
      'list_projects', 'create_project', 'set_leaf_project',
      'list_tool_repository', 'attach_tool_to_leaf', 'update_leaf_memory', 'web_search', 'fetch_web_page',
    ]);
  });

  it('lets only a PROJECT declare a toolchain, never a leaf or a persona', () => {
    /**
     * A toolchain is a dependency of the code, so it belongs to the thing that holds the code. Every
     * persona working in a Go repository needs Go — the framer reading it, the builder writing it,
     * the merger running its tests — which is one fact about the project rather than one about each
     * of them.
     *
     * `set_leaf_workspace` and `propose_leaf`'s `language` were the other arrangement, and both
     * stopped meaning anything the moment something else chose the image.
     */
    expect(LEAF_TOOLS.map((t) => t.function.name)).not.toContain('set_leaf_workspace');
    const takesLanguage = LEAF_TOOLS
      .filter((t) => 'language' in ((t.function.parameters as any)?.properties ?? {}))
      .map((t) => t.function.name);
    expect(takesLanguage).toEqual(['create_project']);
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

  it('points at replace_leaf rather than withdraw for a substitution', () => {
    /**
     * A withdrawn leaf is DELETED, and `dependenciesMet` counts an id that resolves to nothing as
     * met — so anything that named it does not wait, it starts early with no trace of why. That
     * happened in a real run and took a person to spot.
     */
    const tool = LEAF_TOOLS.find((t) => t.function.name === 'replace_leaf')!;

    expect(tool.function.description).toMatch(/carrying anything that depends on it/i);
    expect(tool.function.description).toMatch(/silently loses the ordering/i);
  });

  it('asks for the command a USER would type, not a test run', () => {
    /**
     * The distinction the whole acceptance idea rests on. `npm test` re-runs the per-leaf checks
     * that were already green while the delivered program printed its own name and exited; only
     * running the deliverable catches that.
     */
    const tool = LEAF_TOOLS.find((t) => t.function.name === 'set_acceptance')!;

    const d = tool.function.description;
    // The run is the check that catches a stub entry point; a suite alone passes right over it.
    expect(d).toMatch(/RUN the thing the way the user described it/i);
    expect(d).toMatch(/test suite alone will happily pass/i);
    expect(d).toMatch(/ASSEMBLED whole/);
    // And the guidance is by KIND, because a research request has nothing to run.
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

describe('assigning work to a persona', () => {
  const propose = LEAF_TOOLS.find((t) => t.function.name === 'propose_leaf')!;

  it('lets a proposal name the persona best suited to it', () => {
    // Leaf.personaId has flowed through to execution since personas landed; until now nothing
    // could set it, so every leaf ran as the default no matter who should have done it.
    const persona = (propose.function.parameters as any).properties.persona;
    expect(persona).toBeDefined();
    expect(persona.type).toBe('string');
  });

  it('asks for a name rather than an id, and says so', () => {
    // Same reasoning as dependsOn taking titles: the model knows the names it was shown, and
    // cannot know an id for something it created seconds ago.
    const persona = (propose.function.parameters as any).properties.persona;
    expect(persona.description).toMatch(/name/i);
    expect(persona.description).not.toMatch(/\bid\b/i);
  });

  it('stays optional, so work with no obvious owner needs no ceremony', () => {
    expect((propose.function.parameters as any).required).toEqual(['title']);
  });

  it('offers a way to find out which personas exist', () => {
    // A model cannot assign by name to a list it has never seen, and inventing names it half
    // remembers is the failure this prevents.
    const list = LEAF_TOOLS.find((t) => t.function.name === 'list_personas');
    expect(list).toBeDefined();
    expect(list!.function.description).toMatch(/before assigning/i);
  });
});
