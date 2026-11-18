import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Graph } from './graph.js';
import { repoGraph } from './repo-graph.js';
import { WORKSPACES } from './workspaces.js';

const ROOT = join(import.meta.dirname, '..', '..');

const UNHEARD: Record<string, string> = {
  'sends pipeline-run-updated': 'TemporalBridge tells browsers a pipeline run changed; the builds panel refetches on its own',
  'sends room-denied': 'a log room refused; the log views do not listen, so a refused log shows nothing and no reason',
};

describe('every end of a channel between processes has the other end', () => {
  let graph: Graph;

  it('builds the edges between the backend, the browser and the machine agent', () => {
    const sides = WORKSPACES.filter((workspace) => ['backend', 'frontend', 'local-agent'].includes(workspace.name));
    graph = repoGraph(ROOT, sides);
    expect(graph.edges.filter((edge) => edge.through === 'socket').length).toBeGreaterThan(50);
    expect(graph.edges.filter((edge) => edge.through === 'http').length).toBeGreaterThan(350);
    expect(graph.edges.filter((edge) => edge.through === 'env').length).toBeGreaterThan(25);
    expect(repoGraph(ROOT, sides)).toEqual(graph);
  });

  it('has no socket.io event with only one side, beyond those known', () => {
    const lonely = [...new Set(graph.unmatched.filter((end) => end.kind === 'socket').map((end) => `${end.side} ${end.name}`))];
    expect(lonely.filter((end) => !(end in UNHEARD)).sort()).toEqual([]);
    expect(Object.keys(UNHEARD).filter((end) => !lonely.includes(end)).sort()).toEqual([]);
  });

  it('reads every env name the instance chart sets on Koala\'s own containers', () => {
    expect(graph.unmatched.filter((end) => end.kind === 'env' && end.side === 'sends').map((end) => `${end.name} (${end.site.file}:${end.site.line})`)).toEqual([]);
  });
});
