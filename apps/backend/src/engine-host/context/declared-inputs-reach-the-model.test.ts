import { describe, it, expect } from 'vitest';
import { ALL_SEEDED_AGENTS, type Persona } from '@koala/agent-engine';
import { BUILT_IN_PROCEDURES, type Procedure } from '@koala/agent-engine/procedure';
import { composedRequests, said } from './composed-request.js';

interface Sentinelled {
  inputs: Record<string, unknown>;
  expected: string[];
}

type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[] };

const NOT_SHOWN: Record<string, string[]> = {
  executor: ['item.checks'],
  koala: ['conversationId'],
};

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

const pairs = ALL_SEEDED_AGENTS().flatMap((persona) => {
  const procedure = BUILT_IN_PROCEDURES.find((entry) => entry.id === persona.procedure);
  if (!procedure || !persona.interface?.inputs) return [];
  // The pass procedures are structure: their owner makes no model rounds, so its declared
  // inputs reach the model on the child's prompt instead — pinned by composed-request.test.
  if (persona.slug === 'grove-runner') return [];
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
