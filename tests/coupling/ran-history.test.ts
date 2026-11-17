import { describe, expect, it } from 'vitest';
import type { Edge, Graph, Unit } from './graph.js';
import type { Judged } from './join.js';
import { breaches } from './rules.js';
import { kept, KEPT_RECORDS, lastRan, lastRanLine, ranIn, type RanRecord } from './ran-history.js';

const unit = (id: string): Unit => ({ id, file: `apps/backend/src/x/${id}.ts`, name: id, line: 1, column: 1, start: 0, end: 0, inTest: false });
const edge = (from: string, to: string[]): Edge => ({ from, to, through: 'interface', site: { file: `apps/backend/src/x/${from}.ts`, line: 1, column: 1, start: 0, end: 0 } });
const graph: Graph = { units: Object.fromEntries(['interpreter', 'workflow', 'store'].map((id) => [id, unit(id)])), edges: [], unresolved: [], unmatched: [], records: [] };
const run = (judged: Judged[], commit: string): RanRecord => ({ commit, at: `${commit}-at`, ran: ranIn(judged, graph), units: {}, breaches: {} });
const ranBy = (tests: string[]): Judged => ({ edge: edge('interpreter', ['workflow']), crosses: 'none', covered: tests.map((test) => ({ test, level: 'container', withCaller: true })) });
const unrun: Judged = { edge: edge('interpreter', ['workflow']), crosses: 'none', covered: [] };

describe('which tests last ran a call for real', () => {
  it('names the tests of the latest audit that ran a call the newest audit finds unrun, under the key its breach carries', () => {
    const earlier = run([ranBy(['grove-run.integration.test.ts', 'AgentRunWorkflow.integration.test.ts'])], 'aaa');
    const now = run([unrun], 'bbb');
    const [breach] = breaches([unrun], graph, ['R1']);
    const history = kept([earlier], now);
    expect(lastRan(history, breach!.key)).toEqual({ commit: 'aaa', at: 'aaa-at', tests: ['AgentRunWorkflow.integration.test.ts', 'grove-run.integration.test.ts'] });
    expect(lastRanLine(history, breach!.key)).toBe('  last run for real at aaa (aaa-at) by: AgentRunWorkflow.integration.test.ts, grove-run.integration.test.ts; this run did not, so what those tests do differs between runs');
  });

  it('names the tests that last ran a function an R5 breach is about', () => {
    const record: RanRecord = { commit: 'aaa', at: 'aaa-at', ran: {}, units: { 'apps/backend/src/x/services/Thing.ts#acts': ['Thing.integration.test.ts'] }, breaches: {} };
    expect(lastRanLine([record], 'R5 apps/backend/src/x/services/Thing.ts#acts')).toBe('  last run for real at aaa (aaa-at) by: Thing.integration.test.ts; this run did not, so what those tests do differs between runs');
  });

  it('counts a call made from two places as run only when both places ran, so one place never vouches for the other', () => {
    const elsewhere: Judged = { ...ranBy(['sign-in.integration.test.ts']), edge: { ...edge('interpreter', ['workflow']), site: { file: 'apps/backend/src/x/interpreter.ts', line: 9, column: 1, start: 0, end: 0 } } };
    expect(run([elsewhere, unrun], 'aaa').ran).toEqual({});
    expect(run([unrun, elsewhere], 'aaa').ran).toEqual({});
    expect(Object.values(run([elsewhere, ranBy(['grove-run.integration.test.ts'])], 'aaa').ran)).toEqual([['grove-run.integration.test.ts', 'sign-in.integration.test.ts']]);
  });

  it('says so when no audit it keeps ran the call, and keeps only the latest few audits', () => {
    const [breach] = breaches([unrun], graph, ['R1']);
    expect(lastRanLine([run([unrun], 'ccc')], breach!.key)).toBe(`  no audit of the last ${KEPT_RECORDS} ran it for real either`);
    let history: RanRecord[] = [];
    for (let at = 0; at < KEPT_RECORDS + 2; at += 1) history = kept(history, run([], `c${at}`));
    expect(history.map((record) => record.commit)).toEqual(['c6', 'c5', 'c4', 'c3', 'c2']);
  });
});
