import type { ProposalPart, ProposalSection } from '@koala/harness-types';

export type { ProposalPart, ProposalSection } from '@koala/harness-types';

export const text = (value: string): ProposalPart => ({ kind: 'text', text: value });

export const code = (value: string, label?: string): ProposalPart => ({ kind: 'code', code: value, ...(label ? { label } : {}) });

export function fields(...rows: (readonly [string, string | undefined, 'code'?])[]): ProposalPart {
  return {
    kind: 'fields',
    fields: rows.filter((row) => row[1] !== undefined && row[1] !== '').map(([label, value, shown]) => ({ label, value: value!, ...(shown === 'code' ? { code: true } : {}) })),
  };
}

export const section = (title: string | undefined, parts: ProposalPart[], folded?: string): ProposalSection => ({
  ...(title ? { title } : {}),
  ...(folded ? { folded } : {}),
  parts,
});

const partLines = (part: ProposalPart): string[] => {
  if (part.kind === 'text') return [part.text];
  if (part.kind === 'code') return [part.label ? `${part.label}: ${part.code}` : part.code];
  return part.fields.map((field) => `${field.label}: ${field.value}`);
};

export const sectionLines = (sections: readonly ProposalSection[]): string[] =>
  sections.flatMap((entry) => entry.parts.flatMap(partLines).map((line) => (entry.title ? `${entry.title} — ${line}` : line)));
