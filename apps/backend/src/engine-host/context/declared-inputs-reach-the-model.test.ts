import { describe, it, expect } from 'vitest';
import { type Persona } from '@koala/agent-engine';
import { type Procedure } from '@koala/agent-engine/procedure';
import { composedRequests, said } from './composed-request.js';
import { seededPersonas, seededProcedures } from '../../extensions/seeds.js';

interface Sentinelled {
  inputs: Record<string, unknown>;
  expected: string[];
}

type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[] };

const NOT_SHOWN: Record<string, string[]> = {
  executor: ['item.checks'],
  koala: ['conversationId'],
};

// The structural personas make no model rounds of their own, so what they are given reaches the model somewhere
// else: on a child's prompt or in an operation's inputs (the grove agents run no model; their leaves, judges and
// planners do). They are pinned end to end by extensions/grove/grove-run.test.ts.
const STRUCTURAL = ['grove', 'grove-paper', 'grove-leaf', 'grove-paper-leaf'];

function sentinelsFor(persona: Persona, procedure: Procedure): Sentinelled {
  const skip = new Set(NOT_SHOWN[persona.slug] ?? []);
  const expected: string[] = [];

  const build = (schema: Schema, path: string): unknown => {
    if (skip.has(path)) return undefined;
    if (schema.type === 'object' && schema.properties) {
      const entries = Object.entries(schema.properties)
        .map(([name, child]) => [name, build(child, path ? `${path}.${name}` : name)] as const)
        .filter(([, value]) => value !== undefined);
      return Object.fromEntries(entries);
    }
    const sentinel = `sentinel-${procedure.id}-${path.replace(/\./g, '-')}`;
    expected.push(sentinel);
    return sentinel;
  };

  const schema = (persona.interface?.inputs ?? {}) as Schema;
  const inputs = (build({ ...schema, type: 'object' }, '') ?? {}) as Record<string, unknown>;
  return { inputs, expected };
}

const pairs = seededPersonas().flatMap((persona) => {
  const procedure = seededProcedures().find((entry) => entry.id === persona.procedure);
  if (!procedure || !persona.interface?.inputs) return [];
  if (STRUCTURAL.includes(persona.slug)) return [];
  return [{ persona, procedure }];
});

describe('everything a persona says it takes reaches the model', () => {
  it('has a persona with declared inputs to check', () => {
    expect(pairs.length).toBeGreaterThan(0);
  });

  for (const { persona, procedure } of pairs) {
    it(`${procedure.id} shows the model every input ${persona.slug} declares`, async () => {
      const { inputs, expected } = sentinelsFor(persona, procedure);
      const { requests } = await composedRequests({
        procedure,
        agent: persona.slug,
        message: typeof inputs.message === 'string' ? inputs.message : `sentinel-${procedure.id}-message`,
        inputs,
      });

      expect(requests.length, 'the model was never called').toBeGreaterThan(0);
      const first = `${requests[0]!.system}\n${said(requests[0]!)}`;

      for (const sentinel of expected) {
        expect(first, `${persona.slug} says it takes "${sentinel.replace(`sentinel-${procedure.id}-`, '')}", but ${procedure.id} never puts it in front of the model`)
          .toContain(sentinel);
      }
    });
  }
});
