import { describe, expect, it } from 'vitest';
import { planIsDone, zonePlan, type WantedRecord } from './dns-plan.js';

const a = (name: string, onConflict: WantedRecord['onConflict'] = 'refuse'): WantedRecord => ({ type: 'A', name, content: '203.0.113.7', why: 'root', onConflict });

describe('the plan for a zone\'s records', () => {
  it('creates what is missing and keeps what already says the same, names compared without case or a trailing dot', () => {
    const steps = zonePlan([a('app.koala.test'), a('mesh.koala.test')], [{ id: '1', type: 'A', name: 'MESH.koala.test.', content: '203.0.113.7' }]);
    expect(steps.map((step) => step.do)).toEqual(['create', 'keep']);
    expect(planIsDone(steps)).toBe(true);
  });

  it('refuses to rewrite a record it did not make, saying what to do', () => {
    const [step] = zonePlan([a('app.koala.test')], [{ id: '1', type: 'A', name: 'app.koala.test', content: '198.51.100.1' }]);
    expect(step).toMatchObject({ do: 'refuse', why: expect.stringContaining('198.51.100.1') });
    expect(planIsDone([step!])).toBe(false);
  });

  it('replaces only a record wanted to be replaced, by its id', () => {
    const [step] = zonePlan([a('app.koala.test', 'replace')], [{ id: '7', type: 'A', name: 'app.koala.test', content: '198.51.100.1' }]);
    expect(step).toEqual({ do: 'update', record: { id: '7', type: 'A', name: 'app.koala.test', content: '203.0.113.7' }, why: 'root' });
  });

  it('looks only at the candidates a record names, and counts one as satisfied by its own rule', () => {
    const spf: WantedRecord = {
      type: 'TXT', name: 'koala.test', content: 'v=spf1 ip4:203.0.113.7 ~all', why: 'spf', onConflict: 'refuse',
      candidate: (record) => record.content.startsWith('v=spf1'),
      satisfied: (record) => record.content.includes('ip4:203.0.113.7'),
    };
    const verification = { id: '1', type: 'TXT' as const, name: 'koala.test', content: 'google-site-verification=abc' };
    expect(zonePlan([spf], [verification]).map((step) => step.do)).toEqual(['create']);
    expect(zonePlan([spf], [verification, { id: '2', type: 'TXT', name: 'koala.test', content: 'v=spf1 a ip4:203.0.113.7 ~all' }]).map((step) => step.do)).toEqual(['keep']);
  });
});
