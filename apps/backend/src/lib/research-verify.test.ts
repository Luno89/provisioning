import { describe, it, expect } from 'vitest';
import { assessFindings } from './research-verify.js';

/** The outline that actually passed the first version of this check, verbatim from the run. */
const THE_STUB = `# Temporal vs Restate (v2): Durable Execution, Licensing & Self-Hosting

## Overview
- Brief intro to both projects

## Durable Execution Model
- How Temporal does durable execution
- How Restate does durable execution
- Key differences

## Licensing
- Temporal license
- Restate license

## Self-Hosting
- Temporal self-hosting requirements
- Restate self-hosting requirements

## Sources
- (To be filled)`;

const real = `# Temporal vs Restate

Temporal separates the workflow worker from a central service that owns history, so self-hosting
means running the server, a database and the workers. Restate ships a single binary that holds the
journal itself, which is a much smaller operational footprint but concentrates state in one place.
Temporal is MIT licensed. Restate is BUSL, converting to Apache 2.0 on a delay, which matters for
anyone reselling it. On durability both replay from a journal, but Temporal replays workflow code
deterministically while Restate journals the results of handler invocations, so the constraints on
what you may write inside one differ substantially in practice.

Sources: https://temporal.io/blog and https://restate.dev/blog`;

describe('proving a research leaf actually answered', () => {
  it('rejects the outline that passed the length-only check', () => {
    const r = assessFindings(THE_STUB);
    expect(r.outcome).toBe('failed');
    expect(r.reason).toContain('placeholder');
  });

  it('accepts a real answer with sources', () => {
    expect(assessFindings(real).outcome).toBe('passed');
  });

  it('rejects an empty file', () => {
    expect(assessFindings('   ').outcome).toBe('failed');
    expect(assessFindings('').reason).toContain('nothing was written');
  });

  it('does not count headings as content', () => {
    // A skeleton of headings clears a raw character count while saying nothing.
    const headings = ['# One', '## Two', '### Three', '#### Four', '- a', '- b'].join('\n\n')
      + '\n\nhttps://example.com';
    expect(assessFindings(headings).outcome).toBe('failed');
  });

  it('rejects an answer that cites nothing', () => {
    const noSources = real.replace(/Sources:.*/s, 'Sources: internal knowledge');
    const r = assessFindings(noSources);
    expect(r.outcome).toBe('failed');
    expect(r.reason).toContain('cites no sources');
  });

  it('catches the placeholder spellings a run actually produces', () => {
    for (const marker of ['(To be filled)', 'TBD', 'TODO', '[fill in the rest]', 'Coming soon']) {
      expect(assessFindings(`${real}\n\n${marker}`).outcome).toBe('failed');
    }
  });

  it('gives the same verdict however many times it is called', () => {
    // A /g regex used with .test() advances lastIndex between calls, so the second identical call
    // returns a different answer. Every leaf shares this module.
    for (let i = 0; i < 5; i++) expect(assessFindings(real).outcome).toBe('passed');
  });

  it('names the file it is complaining about', () => {
    expect(assessFindings('', '/work/notes.md').reason).toContain('/work/notes.md');
  });
});
