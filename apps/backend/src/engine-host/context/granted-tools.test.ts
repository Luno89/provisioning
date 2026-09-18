import { describe, it, expect } from 'vitest';
import { ALL_SEEDED_AGENTS, type Persona } from '@koala/agent-engine';
import { BUILT_IN_GROUPS, BUILT_IN_PROCEDURES, type Procedure } from '@koala/agent-engine/procedure';

const nodesOf = (procedure: Procedure) => {
  const groups = new Map([...BUILT_IN_GROUPS, ...procedure.groups].map((group) => [group.id, group]));
  return procedure.nodes.flatMap((node) => (node.kind === 'group' && groups.has(String(node.group))
    ? [node, ...groups.get(String(node.group))!.nodes]
    : [node]));
};

const textSetting = (node: { settings?: Readonly<Record<string, unknown>> }, name: string): string | undefined => {
  const value = node.settings?.[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

export function toolsCalledBy(procedure: Procedure): string[] {
  return [...new Set(nodesOf(procedure)
    .filter((node) => node.kind === 'call-tool')
    .flatMap((node) => (textSetting(node, 'tool') ? [textSetting(node, 'tool')!] : [])))].sort();
}

export function agentsHandedWorkBy(procedure: Procedure): string[] {
  return [...new Set(nodesOf(procedure)
    .filter((node) => node.kind === 'delegate' || node.kind === 'fan-out')
    .flatMap((node) => (textSetting(node, 'agent') ? [textSetting(node, 'agent')!] : [])))].sort();
}

const pairs = ALL_SEEDED_AGENTS().flatMap((persona: Persona) => {
  const procedure = BUILT_IN_PROCEDURES.find((entry) => entry.id === persona.procedure);
  return procedure ? [{ persona, procedure }] : [];
});

describe('a procedure can only call what the persona running it is allowed to', () => {
  for (const { persona, procedure } of pairs) {
    it(`${persona.slug} is granted every tool ${procedure.id} calls`, () => {
      const granted = new Set(persona.tools ?? []);

      for (const tool of toolsCalledBy(procedure)) {
        expect([...granted], `${procedure.id} calls ${tool}, which ${persona.slug} is not granted, so that step can only fail`)
          .toContain(tool);
      }
    });

    it(`${persona.slug} may hand work to everyone ${procedure.id} hands work to`, () => {
      const allowed = new Set(persona.agents ?? []);

      for (const agent of agentsHandedWorkBy(procedure)) {
        expect([...allowed], `${procedure.id} hands work to ${agent}, which ${persona.slug} may not call`)
          .toContain(agent);
      }
    });
  }
});
