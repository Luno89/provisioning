import { describe, it, expect } from 'vitest';
import { personaFits, personasFor, allowedTools, resolvePersona, type WorkContext } from './persona-scope.js';
import type { PersonaScope } from '@koala/harness-types';

const p = (name: string, scope?: any) => ({ name, ...(scope ? { scope } : {}) });
const work = (over: Partial<WorkContext> = {}): WorkContext => ({ context: 'code', ...over });

describe('whether a persona belongs on a piece of work', () => {
  it('lets an unscoped persona work anywhere', () => {
    // Retiring every persona written before scope existed would be a worse outcome than the
    // mismatch this module exists to prevent.
    expect(personaFits(p('Coder'), work({ context: 'research' })).fits).toBe(true);
  });

  it('keeps a planning persona off execution work', () => {
    const v = personaFits(p('Framer', { contexts: ['planning'] }), work({ context: 'research' }));
    expect(v.fits).toBe(false);
    expect(v.reason).toContain('planning');
  });

  it('keeps a persona off work that cannot offer the tools it names', () => {
    const r = p('Researcher', { tools: ['web_search', 'write_file', 'finish'] });
    expect(personaFits(r, work({ available: ['write_file', 'finish'] })).fits).toBe(false);
    expect(personaFits(r, work({ available: ['web_search', 'write_file', 'finish'] })).fits).toBe(true);
  });

  it('treats an unknown environment as not-yet-decided, never as missing', () => {
    // A picker filters before any sandbox exists. Refusing here would hide the persona from the
    // only screen where it can be chosen.
    expect(personaFits(p('Researcher', { tools: ['web_search'] }), work()).fits).toBe(true);
  });

  it('matches on language only when the work names one', () => {
    const goDev = p('Gopher', { languages: ['go'] });
    expect(personaFits(goDev, work({ language: 'node' })).fits).toBe(false);
    expect(personaFits(goDev, work({ language: 'go' })).fits).toBe(true);
    expect(personaFits(goDev, work()).fits).toBe(true);
  });

  it('warns about a different model without refusing it', () => {
    // Prompts transfer imperfectly. Blocking would discard working configurations to prevent a
    // problem that may not exist; silence is what leaves nobody able to explain a regression.
    const v = personaFits(p('Researcher', { tunedFor: 'qwen3.6-27b' }), work({ model: 'llama-70b' }));
    expect(v.fits).toBe(true);
    expect(v.reason).toContain('tuned on qwen3.6-27b');
  });

  it('says nothing when the model is the one it was tuned on', () => {
    expect(personaFits(p('Researcher', { tunedFor: 'qwen3.6-27b' }), work({ model: 'qwen3.6-27b' })).reason).toBeUndefined();
  });

  it('names the persona and the job, not the predicate that failed', () => {
    const v = personaFits(p('Synthesist', { contexts: ['planning'] }), work({ context: 'code' }));
    expect(v.reason).toContain('Synthesist');
    expect(v.reason).toContain('code');
  });

  it('filters a list down to what is worth offering', () => {
    const all = [
      p('Coder'),
      p('Framer', { contexts: ['planning'] }),
      p('Researcher', { contexts: ['research'], tools: ['web_search'] }),
    ];
    const offered = personasFor(all, work({ context: 'research', available: ['web_search'] })).map((x) => x.name);
    expect(offered).toEqual(['Coder', 'Researcher']);
  });
});

describe('the tools a persona actually gets', () => {
  const ALL = ['run_command', 'write_file', 'read_file', 'finish', 'web_search', 'fetch_web_page'];

  it('holds a persona to the subset it declared', () => {
    /**
     * The Framer case, fixed at the mechanism rather than by instruction. It cannot search because
     * it was never handed a search tool, not because it was asked nicely not to.
     */
    const framer = p('Framer', { tools: ['write_file', 'read_file', 'finish'] });
    expect(allowedTools(framer, ALL)).toEqual(['write_file', 'read_file', 'finish']);
  });

  it('does not conjure a tool the environment lacks', () => {
    const r = p('Researcher', { tools: ['web_search', 'write_file', 'finish'] });
    expect(allowedTools(r, ['write_file', 'finish'])).toEqual(['write_file', 'finish']);
  });

  it('gives an undeclared persona everything, as before', () => {
    expect(allowedTools(p('Coder'), ALL)).toEqual(ALL);
    expect(allowedTools(null, ALL)).toEqual(ALL);
  });

  it('treats an empty list as undeclared rather than as "no tools"', () => {
    // A persona with no tools at all could do nothing and finish nothing; an empty array is far
    // more likely to be an authoring accident than an intent.
    expect(allowedTools(p('X', { tools: [] }), ALL)).toEqual(ALL);
  });
});

describe('which persona a piece of work runs as', () => {
  const all: { id: string; name: string; scope?: PersonaScope }[] = [
    { id: 'coder', name: 'Coder', scope: { defaultFor: ['code'] } },
    { id: 'res', name: 'Researcher', scope: { defaultFor: ['research'] } },
    { id: 'named', name: 'Specialist' },
  ];

  it('prefers the persona the work named', () => {
    expect(resolvePersona(all, work(), 'named', 'coder')?.id).toBe('named');
  });

  it('falls back to the one adopted from the Lab', () => {
    // What makes a promotion mean anything: a persona that won on the bench is used by work that
    // did not name one.
    expect(resolvePersona(all, work(), undefined, 'res')?.id).toBe('res');
  });

  it('falls back to the context default rather than to nobody', () => {
    // "No persona" meant a bare sandbox configured by whatever the caller hardcoded.
    expect(resolvePersona(all, work({ context: 'code' }))?.id).toBe('coder');
    expect(resolvePersona(all, work({ context: 'research' }))?.id).toBe('res');
  });

  it('ignores a named persona that no longer exists rather than failing the work', () => {
    expect(resolvePersona(all, work({ context: 'code' }), 'deleted-id')?.id).toBe('coder');
  });

  it('is deterministic when two personas claim the same context', () => {
    const clashing: { id: string; name: string; scope?: PersonaScope }[] = [
      { id: 'b', name: 'Beta', scope: { defaultFor: ['code'] } },
      { id: 'a', name: 'Alpha', scope: { defaultFor: ['code'] } },
    ];
    // An authoring mistake either way; a wrong answer that moves is far harder to notice.
    expect(resolvePersona(clashing, work({ context: 'code' }))?.id).toBe('a');
    expect(resolvePersona([...clashing].reverse(), work({ context: 'code' }))?.id).toBe('a');
  });
});
