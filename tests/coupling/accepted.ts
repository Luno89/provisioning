import type { UntestedList } from '@koala/coupling';
import type { BaselineGrant } from '../alignment/decisions.js';
import { WHOLE_COUNT } from '../lib/baseline-growth.js';

export const UNTESTED_LIST = 'tests/coupling/untested.json';

const countOf = (list: UntestedList): number => Object.values(list).reduce((total, count) => total + count, 0);

export function acceptedUntested(list: UntestedList, now: UntestedList, granted: readonly BaselineGrant[]): { list: UntestedList } | { refused: string } {
  const from = countOf(list);
  const to = countOf(now);
  if (to <= from) return { list: now };
  const grant = granted.find((one) => one.path === UNTESTED_LIST && one.rule === WHOLE_COUNT && one.from === from);
  if (!grant) return { refused: `the untested list would grow from ${from} to ${to}, which needs the owner's yes recorded in the decisions register` };
  if (to > grant.to) return { refused: `the untested list would grow from ${from} to ${to}, past the ${grant.to} the register allows` };
  return { list: now };
}
