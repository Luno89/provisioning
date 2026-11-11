import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourceOf } from './artifacts.js';
import { buildGraph, isTest, type Graph } from './graph.js';
import { MATCHES, outsideEnds, projectsOf, WORKSPACES, workspaceOf, type Workspace } from './workspaces.js';

type Detail = { withinFiles?: boolean; handOffs?: boolean };

export const graphKey = (root: string, workspaces: readonly Workspace[], detail: Detail): string => createHash('sha256')
  .update(sourceOf(root, 'all', ['apps', 'packages', 'scripts', 'charts', 'tests']))
  .update(JSON.stringify({ workspaces: workspaces.map((workspace) => workspace.name), withinFiles: detail.withinFiles ?? false, handOffs: detail.handOffs ?? false }))
  .digest('hex')
  .slice(0, 24);

export const graphsIn = (root: string): string => join(root, 'tests', '.coupling', 'graphs');

export const repoGraph = (root: string, workspaces: readonly Workspace[] = WORKSPACES, detail: Detail = {}): Graph => {
  const folder = graphsIn(root);
  const kept = join(folder, `${graphKey(root, workspaces, detail)}.json`);
  if (existsSync(kept)) return JSON.parse(readFileSync(kept, 'utf8')) as Graph;
  const graph = buildGraph({ projects: projectsOf(root, workspaces), root, matches: MATCHES, extraEnds: outsideEnds(root), calledFrom: (file) => !isTest(file) && workspaceOf(file) !== undefined, ...detail });
  mkdirSync(folder, { recursive: true });
  const writing = `${kept}.${process.pid}`;
  writeFileSync(writing, JSON.stringify(graph));
  renameSync(writing, kept);
  return graph;
};
