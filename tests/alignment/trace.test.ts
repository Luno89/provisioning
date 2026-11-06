import { describe, expect, it } from 'vitest';
import type { Edge, Graph, Unit } from '../coupling/graph.js';
import type { Step } from './flow-spec.js';
import { traceStep } from './trace.js';

const unit = (file: string, name: string): Unit => ({ id: `${file}#${name}`, file, name, line: 1, column: 1, start: 0, end: 10, inTest: false });

const SCREEN = unit('apps/frontend/src/features/x/components/Page.tsx', 'Page');
const CALL = unit('apps/frontend/src/features/x/api.ts', 'signInPlace');
const ROUTE = unit('apps/backend/src/x/routes/sign-in.ts', '(anonymous)');
const READ = unit('apps/backend/src/x/services/Read.ts', 'read');
const STORE = unit('apps/backend/src/x/store.ts', 'save');

const edge = (from: Unit, to: Unit, through: Edge['through']): Edge =>
  ({ from: from.id, to: [to.id], through, site: { file: from.file, line: 1, column: 1, start: 0, end: 0 } });

const GRAPH: Graph = {
  units: Object.fromEntries([SCREEN, CALL, ROUTE, READ, STORE].map((entry) => [entry.id, entry])),
  edges: [edge(SCREEN, CALL, 'reference'), edge(CALL, ROUTE, 'http'), edge(ROUTE, READ, 'call'), edge(SCREEN, STORE, 'call')],
  unresolved: [],
  unmatched: [],
};

const step = (overrides: Partial<Step>): Step => ({ id: 'D1', does: 'signs in', screen: { on: 'instance', component: `${SCREEN.file}#Page` }, decisions: ['root'], ...overrides });

describe('a step traced from where it starts', () => {
  it('starts from the call its action makes, not everything its screen does', () => {
    const trace = traceStep(GRAPH, step({ code: [`${CALL.file}#signInPlace`] }), ['store'], [{ unit: STORE.id, concept: 'store', line: 1 }]);
    expect(trace.starts).toEqual([`${CALL.file}#signInPlace`]);
    expect(trace.files).not.toContain(STORE.file);
  });

  it('keeps a path that crosses into another process even when nothing past it touches a concept', () => {
    const trace = traceStep(GRAPH, step({ code: [`${CALL.file}#signInPlace`] }), ['store'], []);
    expect(trace.crossings).toEqual([{ through: 'http', from: CALL.file, to: ROUTE.file }]);
    expect(trace.files).toEqual([ROUTE.file, CALL.file].sort());
    expect(trace.concepts).toEqual({});
  });

  it('starts from the screen when the step names no call, and from nothing when it names neither', () => {
    expect(traceStep(GRAPH, step({}), ['store'], [{ unit: STORE.id, concept: 'store', line: 1 }]).concepts).toEqual({ store: 1 });
    const nowhere = traceStep(GRAPH, step({ screen: { on: 'machine' } }), ['store'], []);
    expect(nowhere.starts).toEqual([]);
    expect(nowhere.files).toEqual([]);
  });

  it('says which starting points the graph does not hold', () => {
    expect(traceStep(GRAPH, step({ code: ['scripts/dev.sh#(script)'] }), [], []).notFound).toEqual(['scripts/dev.sh#(script)']);
  });
});
