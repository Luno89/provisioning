import { describe, it, expect } from 'vitest';
import { ALL_SEEDED_AGENTS, type Persona } from '@koala/agent-engine';
import { BUILT_IN_GROUPS, BUILT_IN_PROCEDURES, type Procedure } from '@koala/agent-engine/procedure';

const TEMPLATE = /\{\{\s*([\w.]+)\s*\}\}/g;

export function valuePathsIn(procedure: Procedure): string[] {
  const groups = new Map(BUILT_IN_GROUPS.map((group) => [group.id, group]));
  const nodes = procedure.nodes.flatMap((node) => (node.kind === 'group' && groups.has(String(node.settings.group))
    ? [node, ...groups.get(String(node.settings.group))!.nodes]
    : [node]));

  const paths = new Set<string>();
  for (const node of nodes) {
    for (const value of Object.values(node.settings ?? {})) {
      if (typeof value !== 'string') continue;
      for (const [, path] of value.matchAll(TEMPLATE)) {
        if (path?.startsWith('values.')) paths.add(path.slice('values.'.length));
      }
    }
  }
  return [...paths].sort();
}

const declaredOf = (persona: Persona): { names: string[]; required: string[] } => {
  const schema = persona.interface?.inputs as { properties?: Record<string, unknown>; required?: string[] } | undefined;
  return { names: Object.keys(schema?.properties ?? {}), required: schema?.required ?? [] };
};

const rootOf = (path: string): string => path.split('.')[0]!;

const pairs = ALL_SEEDED_AGENTS().flatMap((persona) => {
  const procedure = BUILT_IN_PROCEDURES.find((entry) => entry.id === persona.procedure);
  return procedure ? [{ persona, procedure }] : [];
});

describe('what a persona says it needs, and what its procedure actually reads', () => {
  it('pairs every seeded persona with a built-in procedure', () => {
    expect(pairs.map(({ persona }) => persona.slug).sort())
      .toEqual(ALL_SEEDED_AGENTS().map((persona) => persona.slug).sort());
  });

  for (const { persona, procedure } of pairs) {
    it(`${persona.slug} declares every input ${procedure.id} reads`, () => {
      const read = [...new Set(valuePathsIn(procedure).map(rootOf))];
      const { names } = declaredOf(persona);

      for (const input of read) {
        expect(names, `${procedure.id} reads "${input}", which ${persona.slug} never declares, so nothing asking it to work knows to send one`)
          .toContain(input);
      }
    });

  }
});
