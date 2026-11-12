import { describe, expect, it } from 'vitest';
import { slowerThanUsual, type Timed, overBudget } from './timings.js';

const timed = (commit: string, name: string, seconds: number, kind: Timed['kind'] = 'step'): Timed => ({ at: '2026-11-10T00:00:00Z', commit, kind, name, seconds });

describe('what a gate run took that it usually does not', () => {
  it('names a step much slower than its usual time over its last runs', () => {
    const history = [timed('a', 'lint', 90), timed('b', 'lint', 95), timed('c', 'lint', 85), timed('now', 'lint', 300)];
    expect(slowerThanUsual(history, 'now')).toEqual(['step lint: 5.0 min, usually 90 s over its last 3 runs']);
  });

  it('says nothing for a small change, a step with no history, or a slow step that is only a little slower', () => {
    expect(slowerThanUsual([timed('a', 'unit', 10), timed('now', 'unit', 40)], 'now')).toEqual([]);
    expect(slowerThanUsual([timed('now', 'new step', 900)], 'now')).toEqual([]);
    expect(slowerThanUsual([timed('a', 'checks', 2800), timed('now', 'checks', 3300)], 'now')).toEqual([]);
  });

  it('compares only the latest runs, and a check and a step of the same name apart', () => {
    const history = [
      ...['1', '2', '3', '4', '5', '6', '7'].map((commit, index) => timed(commit, 'odoo', index < 2 ? 3000 : 600)),
      timed('x', 'odoo', 60, 'check'),
      timed('now', 'odoo', 1000),
      timed('now', 'odoo', 70, 'check'),
    ];
    expect(slowerThanUsual(history, 'now')).toEqual(['step odoo: 16.7 min, usually 10.0 min over its last 5 runs']);
  });
});

describe('tests that take too long', () => {
  it('names a unit test past a second and an integration test past thirty, slowest first, and nothing within its budget', () => {
    expect(overBudget([
      { name: 'a.test.ts > quick', tier: 'unit', seconds: 0.2 },
      { name: 'b.test.ts > slow', tier: 'unit', seconds: 1.4 },
      { name: 'c.integration.test.ts > fine', tier: 'integration', seconds: 12 },
      { name: 'd.integration.test.ts > slower', tier: 'integration', seconds: 95 },
    ])).toEqual([
      'd.integration.test.ts > slower: 95 s, over the 30 s an integration test may take',
      'b.test.ts > slow: 1.4 s, over the 1 s a unit test may take',
    ]);
  });
});
