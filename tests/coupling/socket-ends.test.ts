import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGraph, isTest, type Graph } from './graph.js';
import { projectsOf, WORKSPACES, workspaceOf } from './workspaces.js';

const ROOT = join(import.meta.dirname, '..', '..');

const UNHEARD: Record<string, string> = {
  'sends cluster-updated': 'TemporalBridge and ClusterService tell browsers a cluster changed; no page listens, Infrastructure refetches on its own',
  'sends cluster:updated': 'ClusterService tells browsers a cluster changed; no page listens',
  'sends deployment:updated': 'AppService tells browsers an app changed; pages listen for deployment-updated instead',
  'sends pipeline-run-updated': 'TemporalBridge tells browsers a pipeline run changed; the builds panel refetches on its own',
  'sends room-denied': 'a log room refused; the log views do not listen, so a refused log shows nothing and no reason',
};

describe('every socket.io event one side sends, another hears', () => {
  let graph: Graph;

  it('builds the edges between the backend, the browser and the machine agent', () => {
    const sides = WORKSPACES.filter((workspace) => ['backend', 'frontend', 'local-agent'].includes(workspace.name));
    graph = buildGraph({ projects: projectsOf(ROOT, sides), root: ROOT, calledFrom: (file) => !isTest(file) && workspaceOf(file) !== undefined });
    expect(graph.edges.filter((edge) => edge.through === 'socket').length).toBeGreaterThan(50);
  }, 300_000);

  it('has no event with only one side, beyond those known', () => {
    const lonely = [...new Set(graph.unmatched.filter((end) => end.kind === 'socket').map((end) => `${end.side} ${end.name}`))];
    expect(lonely.filter((end) => !(end in UNHEARD)).sort()).toEqual([]);
    expect(Object.keys(UNHEARD).filter((end) => !lonely.includes(end)).sort()).toEqual([]);
  });
});
