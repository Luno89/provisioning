import { describe, it, expect } from 'vitest';
import { allowedTools, usesRepo, flattenPersona } from './persona-scope.js';
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

describe('whether a persona gets the repository', () => {
  it('defaults to yes, because losing a checkout loses the work', () => {
    // Every leaf had one before personas owned their environment. A persona written then must not
    // silently lose its repository — the sandbox is destroyed when the leaf ends.
    expect(usesRepo(p('Coder'))).toBe(true);
    expect(usesRepo(p('Coder', {}))).toBe(true);
    expect(usesRepo(null)).toBe(true);
  });

  it('is off only when the persona says so', () => {
    expect(usesRepo(p('Researcher', { repo: false }))).toBe(false);
    expect(usesRepo(p('Builder', { repo: true }))).toBe(true);
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
