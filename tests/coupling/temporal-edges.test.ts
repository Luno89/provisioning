import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGraph, isTest, type Graph } from './graph.js';
import { temporalWorld } from './temporal-edges.js';

const ROOT = join(import.meta.dirname, 'fixture-temporal');
const TABLES = { workers: { host: 'worker-host.ts', cluster: 'worker-cluster.ts' }, startedOn: { DemoWorkflow: 'host', OtherWorkflow: 'cluster' } } as const;

const graph: Graph = buildGraph({
  projects: [{
    tsconfig: join(ROOT, 'tsconfig.json'),
    owns: () => true,
    crossing: (program) => {
      const world = temporalWorld(program, join(ROOT, 'src'), { workers: TABLES.workers, startedOn: { ...TABLES.startedOn } });
      return (call) => {
        const proxied = world.proxied(call);
        return proxied ? { to: world.implementations(proxied), through: 'temporal' } : undefined;
      };
    },
  }],
  root: ROOT,
  calledFrom: (file) => !isTest(file),
});

const into = (file: string): Array<{ through: string; to: string[] }> => graph.edges.filter((edge) => edge.site.file === file)
  .map((edge) => ({ through: edge.through, to: edge.to.map((id) => `${graph.units[id]!.file}#${graph.units[id]!.name}`).sort() }));

describe('Temporal edges', () => {
  it('reach the activity the worker of the workflow\'s queue registers, destructured or called on the proxy', () => {
    expect(into('src/workflows/DemoWorkflow.ts')).toEqual(expect.arrayContaining([
      { through: 'temporal', to: ['src/activities/greet.ts#Greet'] },
      { through: 'temporal', to: ['src/activities/greet.ts#Count'] },
    ]));
  });

  it('reach every queue a shared helper is called on, through the workflows that import it', () => {
    expect(into('src/workflows/shared.ts').filter((edge) => edge.through === 'temporal')).toEqual([{ through: 'temporal', to: ['src/activities/ready-cluster.ts#Ready', 'src/activities/ready-host.ts#Ready'] }]);
  });

  it('are never taken as a call inside the workflow\'s process', () => {
    expect(graph.edges.filter((edge) => edge.site.file.startsWith('src/workflows/') && edge.to.some((id) => graph.units[id]!.file.startsWith('src/activities/')) && edge.through !== 'temporal')).toEqual([]);
  });
});
