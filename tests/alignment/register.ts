import type { Decision, Words } from './decisions.js';
import type { Said } from './said.js';

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();

const sameMinute = (words: Words, said: Said): boolean => said.at.slice(0, 16) === words.at.slice(0, 16);

export function sourceOf(words: Words, said: readonly Said[]): Said | undefined {
  const text = flat(words.text);
  return said.find((entry) => sameMinute(words, entry)
    && flat(entry.text).includes(text)
    && (words.asked === undefined ? entry.question === undefined : entry.question !== undefined && flat(entry.question).includes(flat(words.asked))));
}

export function registerProblems(decisions: readonly Decision[], said: readonly Said[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const decision of decisions) {
    if (ids.has(decision.id)) problems.push(`${decision.id}: the id is used twice`);
    ids.add(decision.id);
    if (decision.words.length === 0) problems.push(`${decision.id}: no words of the owner's behind it`);
    if (decision.terms.length === 0) problems.push(`${decision.id}: no terms, so drift cannot find what it is about`);
    for (const words of [...decision.words, ...(decision.replaced ?? []).map((replaced) => replaced.words)]) {
      if (!sourceOf(words, said)) problems.push(`${decision.id}: "${words.text.slice(0, 80)}" is not what the owner said at ${words.at}`);
    }
  }
  return problems;
}
