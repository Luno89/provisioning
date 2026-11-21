import { describe, expect, it } from 'vitest';
import type { Judgement, JudgedUnit } from '@koala/coupling';
import { backtest, faultEvidence, type KnownFault } from './faults.js';

const fn = (id: string, risk: number, runAt: JudgedUnit['runAt'] = []): JudgedUnit => ({ id, file: `${id}.ts`, name: id, line: 1, runAt, confidence: 0, risk });

const judged = (functions: JudgedUnit[]): Judgement => ({ units: functions, functions: [...functions].sort((a, b) => b.risk - a.risk), links: [], untested: [], blocking: [], unchecked: [] });

const FAULTS: KnownFault[] = [
  { file: 'risky.ts', name: 'risky', what: 'a race under fast writes', fixedIn: 'aaa' },
  { file: 'calm.ts', name: 'calm', what: 'a socket that never connected', fixedIn: 'bbb' },
  { file: 'gone.ts', name: 'gone', what: 'removed since', fixedIn: 'ccc' },
];

describe('the faults Koala really had, against the risk the coupler gives their code', () => {
  it('says where each fault\'s function ranks among all functions, riskiest first, and which layers had run it', () => {
    const result = backtest(judged([fn('risky', 9, ['unit']), fn('a', 5), fn('b', 4), fn('calm', 1, ['unit', 'component'])]), FAULTS);

    expect(result.faults).toEqual([
      { fault: FAULTS[0], found: true, rank: 1, ofAll: 4, percentile: 100, runAt: ['unit'] },
      { fault: FAULTS[1], found: true, rank: 4, ofAll: 4, percentile: 25, runAt: ['unit', 'component'] },
      { fault: FAULTS[2], found: false },
    ]);
    expect(result.inRiskierHalf).toBe(1);
    expect(result.judged).toBe(2);
  });

  it('counts a real fault as a miss for every layer that had run its function, since those tests did not catch it', () => {
    const result = backtest(judged([fn('risky', 9, ['unit']), fn('calm', 1, ['unit', 'component'])]), FAULTS);

    expect(faultEvidence(result)).toEqual([
      { layer: 'unit', caught: false },
      { layer: 'unit', caught: false },
      { layer: 'component', caught: false },
    ]);
  });
});
