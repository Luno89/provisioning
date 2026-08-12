import { describe, it, expect } from 'vitest';
import { allowedTools, usesRepo, flattenPersona, personaWorkspace } from './persona-scope.js';
import type { Persona } from '@koala/harness-types';

const p = (name: string, scope?: Persona['scope']) => ({ name, ...(scope ? { scope } : {}) });

describe('the tools a persona actually gets', () => {
  const ALL = ['run_command', 'write_file', 'read_file', 'finish', 'web_search', 'fetch_web_page'];

  it('holds a persona to the subset it declared', () => {
    /**
     * The Framer case, fixed at the mechanism rather than by instruction. It cannot search because
     * it was never handed a search tool, not because it was asked nicely not to.
     */
    expect(allowedTools(p('Framer', { tools: ['write_file', 'read_file', 'finish'] }), ALL))
      .toEqual(['write_file', 'read_file', 'finish']);
  });

  it('does not conjure a tool the environment lacks', () => {
    expect(allowedTools(p('Researcher', { tools: ['web_search', 'write_file'] }), ['write_file', 'finish']))
      .toEqual(['write_file']);
  });

  it('gives an undeclared persona everything, as before', () => {
    expect(allowedTools(p('Coder'), ALL)).toEqual(ALL);
    expect(allowedTools(null, ALL)).toEqual(ALL);
  });

  it('treats an empty list as undeclared rather than as "no tools"', () => {
    // A persona with no tools could do nothing and finish nothing; an empty array is far more
    // likely to be an authoring accident than an intent.
    expect(allowedTools(p('X', { tools: [] }), ALL)).toEqual(ALL);
  });
});

describe('whether a persona works in the repository', () => {
  it('defaults to NO, because most work is not a codebase', () => {
    /**
     * Asking a question, comparing two options, writing up what was found — none of it needs a
     * checkout, and giving it one leaves an empty repository nobody opens. Defaulting the other way
     * is what produced 27 projects of which 26 never built, one per request.
     */
    expect(usesRepo(p('Researcher'))).toBe(false);
    expect(usesRepo(p('Researcher', {}))).toBe(false);
    expect(usesRepo(null)).toBe(false);
  });

  it('gives one to a persona that asks', () => {
    expect(usesRepo(p('Builder', { repo: true }))).toBe(true);
  });

  it('treats an explicit false the same as saying nothing', () => {
    // Both mean "I do not write files". Only `true` provisions anything.
    expect(usesRepo(p('Researcher', { repo: false }))).toBe(false);
  });
});

describe('a persona defined as "that one, but ..."', () => {
  type Flat = Pick<Persona, 'id' | 'name' | 'basedOn' | 'systemPrompt' | 'overrides' | 'scope'>;
  const parent: Flat = {
    id: 'researcher', name: 'Researcher', systemPrompt: 'answer one question',
    overrides: { temperature: 0.4 },
    scope: {
      tools: ['web_search', 'write_file', 'finish'],
      repo: false,
      output: '/work/findings.md',
      run: { maxSteps: 100, withdraw: { afterStep: 50, tools: ['web_search'] } },
    },
  };

  it('inherits everything it does not change', () => {
    const child: Flat = { id: 'short', name: 'Researcher (short)', overrides: {}, basedOn: 'researcher',
      scope: { run: { maxSteps: 40 } } };
    const flat = flattenPersona(child, [parent, child]);
    expect(flat.scope!.run!.maxSteps).toBe(40);
    // A variation must differ in ONE place, or the comparison it exists for is meaningless.
    expect(flat.systemPrompt).toBe('answer one question');
    expect(flat.scope!.tools).toEqual(['web_search', 'write_file', 'finish']);
    expect(flat.scope!.repo).toBe(false);
    expect(flat.scope!.output).toBe('/work/findings.md');
    expect(flat.scope!.run!.withdraw).toEqual({ afterStep: 50, tools: ['web_search'] });
    expect(flat.overrides).toEqual({ temperature: 0.4 });
  });

  it('lets the child win field by field', () => {
    const child: Flat = { id: 'cold', name: 'Researcher (cold)', overrides: { temperature: 0.1 }, basedOn: 'researcher' };
    const flat = flattenPersona(child, [parent, child]);
    expect(flat.overrides).toEqual({ temperature: 0.1 });
    expect(flat.scope!.run!.maxSteps).toBe(100);
  });

  it('ignores a parent that no longer exists rather than failing the work', () => {
    const orphan: Flat = { id: 'x', name: 'Orphan', overrides: {}, basedOn: 'deleted' };
    expect(flattenPersona(orphan, [orphan]).name).toBe('Orphan');
  });

  it('stops at a cycle instead of looping forever', () => {
    const a: Flat = { id: 'a', name: 'A', overrides: {}, basedOn: 'b' };
    const b: Flat = { id: 'b', name: 'B', overrides: {}, basedOn: 'a' };
    expect(flattenPersona(a, [a, b]).name).toBe('A');
  });
});

describe('the container a persona runs in', () => {
  const ids = { leafId: 'leaf-1', ownerId: 'u1' };

  it('takes everything it can from the record', () => {
    const spec = personaWorkspace(
      p('Heavy', { language: 'go', cpu: '4', memory: '8Gi', egress: [{ namespace: 'gitea', ports: [3000] }], env: [{ name: 'TOKEN', value: 'x' }] }),
      ids,
    );
    expect(spec).toMatchObject({
      leafId: 'leaf-1', ownerId: 'u1', cpu: '4', memory: '8Gi',
      egress: [{ namespace: 'gitea', ports: [3000] }],
      env: [{ name: 'TOKEN', value: 'x' }],
    });
    expect(spec.image).toContain('go-toolset');
  });

  it("lets the project's toolchain win over the persona's own", () => {
    /**
     * A Go repository needs Go whichever persona is standing in it. The persona's language is what
     * it runs in when there is no project — a Researcher writing prose should not inherit a
     * compiler from whatever it happens to be working alongside.
     */
    const spec = personaWorkspace(p('Builder', { language: 'node' }), ids, { language: 'go' });
    expect(spec.image).toContain('go-toolset');
  });

  it("uses the persona's own toolchain when there is no project", () => {
    expect(personaWorkspace(p('Researcher', { language: 'base' }), ids).image).toContain('ubi');
  });

  it('carries no image at all when neither says', () => {
    // The platform default applies downstream; inventing one here would hide that nobody chose.
    expect(personaWorkspace(p('Plain'), ids).image).toBeUndefined();
  });

  it('distinguishes an unstated network from a deliberately closed one', () => {
    /**
     * Absent leaves the caller free to open what a clone needs; empty is a persona saying "open
     * nothing". Collapsing the two would either strand a builder that cannot reach Gitea or quietly
     * give the network back to a persona that refused it.
     */
    expect(personaWorkspace(p('Unstated'), ids).egress).toBeUndefined();
    expect(personaWorkspace(p('Closed', { egress: [] }), ids).egress).toEqual([]);
  });

  it('carries nothing extra for a persona that declares nothing', () => {
    expect(personaWorkspace(null, ids)).toEqual({ leafId: 'leaf-1', ownerId: 'u1' });
  });
});
