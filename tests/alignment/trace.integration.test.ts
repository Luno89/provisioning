import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../coupling/artifacts.js';
import { CONCEPTS } from '../coupling/concepts.js';
import { touchesIn } from '../coupling/flows.js';
import { repoGraph } from '../coupling/repo-graph.js';
import { DECISIONS } from './decisions.js';
import { driftOf } from './drift.js';
import { traceStep, type StepTrace } from './trace.js';
import { V1_FLOWS } from './v1-flows.js';

const graph = repoGraph(ROOT, undefined, { withinFiles: true, handOffs: true });
const touches = touchesIn(graph, (file) => {
  const path = join(ROOT, file);
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}, CONCEPTS);
const traces = new Map(V1_FLOWS.flatMap((flow) => flow.steps).map((step) => [step.id, traceStep(graph, step, CONCEPTS.map((concept) => concept.id), touches)]));
const traced = (id: string): StepTrace => traces.get(id)!;

describe('the v1 steps, traced through this repository from the screen the person is on', () => {
  it('finds where every step starts, but a script the graph knows only by the Koala API calls it makes', () => {
    const lost = [...traces.values()].flatMap((trace) => trace.notFound);
    expect(lost.every((entry) => entry.endsWith('#(script)'))).toBe(true);
  });

  it('follows the app list from Infrastructure through the screen\'s hook and over HTTP into the backend', () => {
    const list = traced('E7');
    expect(list.crossings.some((crossing) => crossing.through === 'http' && crossing.to.startsWith('apps/backend/src/infrastructure/'))).toBe(true);
  });

  it('follows a deploy from the wizard\'s call over HTTP to the workflow the backend starts', () => {
    const deploy = traced('E2');
    expect(deploy.crossings.map((crossing) => crossing.through)).toEqual(expect.arrayContaining(['http', 'temporal']));
  });

  it('follows sign-in\'s one question to both backends that answer it, root\'s and an instance\'s', () => {
    const answeredBy = traced('D1').crossings.filter((crossing) => crossing.through === 'http').map((crossing) => crossing.to).sort();
    expect(answeredBy).toEqual(['apps/backend/src/accounts/routes/auth.ts', 'apps/backend/src/instances/routes/sign-in.ts']);
  });

  it('follows removing a machine over HTTP and on to the machine over its socket', () => {
    expect(traced('G2').crossings.map((crossing) => crossing.through)).toEqual(expect.arrayContaining(['http', 'socket']));
  });

  it('starts nothing for a step that names neither a screen\'s component nor code', () => {
    expect(traced('I2').starts).toEqual([]);
  });

  it('reports the code still keeping what the decisions remove as known work, and adding a machine as one path with two doors', () => {
    const sourceOf = (file: string): string | undefined => {
      const path = join(ROOT, file);
      return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    };
    const found = driftOf({ flows: V1_FLOWS, decisions: DECISIONS, traces, sourceOf, plans: [], said: [] });
    expect(found.find((finding) => finding.id === 'decided-not-done:Docker')?.steps).toEqual(expect.arrayContaining(['F2']));
    expect(found.some((finding) => finding.id === 'decided-not-done:k3d')).toBe(false);
    expect(found.some((finding) => finding.id === 'two-paths:Add a machine')).toBe(false);
  });
});
