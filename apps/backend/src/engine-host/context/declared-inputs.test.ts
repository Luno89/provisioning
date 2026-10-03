import { describe, it, expect } from 'vitest';
import { type Persona } from '@koala/agent-engine';
import { BUILT_IN_GROUPS, type Procedure } from '@koala/agent-engine/procedure';
import { seededPersonas, seededProcedures } from '../../extensions/seeds.js';

const TEMPLATE = /\{\{\s*([\w.]+)\s*\}\}/g;

/** The nodes whose {{values.…}} really do mean the run's inputs: their values socket is fed by the run-input node.
 *  A node fed from somewhere else — a tool's result, a child's outcome — is naming that value's shape, not asking the
 *  caller for one, so what it reads is not an input the persona owes. Group instances keep their inner references: a
 *  group's values arrive through the group's own socket, which the caller feeds. */
const fedByRunInputs = (procedure: Procedure): Set<string> => {
  const runInputs = new Set(procedure.nodes.filter((node) => node.kind === 'run-input').map((node) => node.id));
  return new Set(procedure.wires
    .filter((wire) => wire.to.socket === 'values' && runInputs.has(wire.from.node))
    .map((wire) => wire.to.node));
};

export function valuePathsIn(procedure: Procedure): string[] {
  const groups = new Map(BUILT_IN_GROUPS.map((group) => [group.id, group]));
  const fed = fedByRunInputs(procedure);
  const nodes = procedure.nodes.flatMap((node) => {
    if (node.kind === 'group' && groups.has(String(node.settings.group))) return [node, ...groups.get(String(node.settings.group))!.nodes];
    return fed.has(node.id) ? [node] : [];
  });

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

const pairs = seededPersonas().flatMap((persona) => {
  const procedure = seededProcedures().find((entry) => entry.id === persona.procedure);
  return procedure ? [{ persona, procedure }] : [];
});

describe('what a persona says it needs, and what its procedure actually reads', () => {
  it('pairs every seeded persona with a built-in procedure', () => {
    expect(pairs.map(({ persona }) => persona.slug).sort())
      .toEqual(seededPersonas().map((persona) => persona.slug).sort());
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
