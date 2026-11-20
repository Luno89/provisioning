import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourceOf } from './artifacts.js';
import { assemble, buildParts, hashText, isTest, type Graph, type GraphOptions, type ProjectPart } from './graph.js';
import { MATCHES, outsideEnds, projectsOf, WORKSPACES, workspaceOf, type Workspace } from './workspaces.js';
import { DEPENDENCIES } from './v2.js';

type Detail = { withinFiles?: boolean; handOffs?: boolean };

export const graphKey = (root: string, workspaces: readonly Workspace[], detail: Detail): string => createHash('sha256')
  .update(sourceOf(root, 'all', ['apps', 'packages', 'scripts', 'charts', 'tests']))
  .update(JSON.stringify({ workspaces: workspaces.map((workspace) => workspace.name), withinFiles: detail.withinFiles ?? false, handOffs: detail.handOffs ?? false }))
  .digest('hex')
  .slice(0, 24);

export const graphsIn = (root: string): string => join(root, 'tests', '.coupling', 'graphs');

const TOOL = join(import.meta.dirname);
const KEPT_GRAPHS = 4;

export const partsKey = (root: string, workspaces: readonly Workspace[], detail: Detail): string => {
  const hash = createHash('sha256');
  for (const file of readdirSync(TOOL).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts')).sort()) hash.update(file).update(readFileSync(join(TOOL, file)));
  hash.update(readFileSync(join(root, 'package-lock.json')));
  for (const workspace of workspaces) hash.update(readFileSync(join(root, workspace.folder, workspace.tsconfig)));
  hash.update(JSON.stringify({ workspaces: workspaces.map((workspace) => workspace.name), withinFiles: detail.withinFiles ?? false, handOffs: detail.handOffs ?? false }));
  return hash.digest('hex').slice(0, 24);
};

const writeWhole = (file: string, value: unknown): void => {
  const writing = `${file}.${process.pid}`;
  writeFileSync(writing, JSON.stringify(value));
  renameSync(writing, file);
};

const keepNewest = (folder: string, matching: RegExp, count: number): void => {
  const found = readdirSync(folder).filter((name) => matching.test(name)).map((name) => ({ name, at: statSync(join(folder, name)).mtimeMs })).sort((a, b) => b.at - a.at);
  for (const old of found.slice(count)) rmSync(join(folder, old.name), { force: true });
};

export interface Built { graph: Graph; reused?: { workspaces: number; of: number } }

export const builtGraph = (root: string, workspaces: readonly Workspace[] = WORKSPACES, detail: Detail = {}): Built => {
  const folder = graphsIn(root);
  const kept = join(folder, `${graphKey(root, workspaces, detail)}.json`);
  if (existsSync(kept)) return { graph: JSON.parse(readFileSync(kept, 'utf8')) as Graph };
  mkdirSync(folder, { recursive: true });
  const options: GraphOptions = { projects: projectsOf(root, workspaces), root, matches: MATCHES, extraEnds: outsideEnds(root), calledFrom: (file) => !isTest(file) && workspaceOf(file) !== undefined, dependencies: (module) => module in DEPENDENCIES, ...detail };
  const partsFile = join(folder, `parts-${partsKey(root, workspaces, detail)}.json`);
  const cached = existsSync(partsFile) ? JSON.parse(readFileSync(partsFile, 'utf8')) as ProjectPart[] : undefined;
  const hashes = new Map<string, string | undefined>();
  const hashOf = (file: string): string | undefined => {
    if (!hashes.has(file)) hashes.set(file, existsSync(join(root, file)) ? hashText(readFileSync(join(root, file), 'utf8')) : undefined);
    return hashes.get(file);
  };
  const { parts, reused } = buildParts(options, cached ? { hashOf, parts: cached } : undefined);
  const graph = assemble(options, parts);
  writeWhole(kept, graph);
  writeWhole(partsFile, parts);
  keepNewest(folder, /^[0-9a-f]{24}\.json$/, KEPT_GRAPHS);
  keepNewest(folder, /^parts-[0-9a-f]{24}\.json$/, KEPT_GRAPHS);
  return { graph, ...(cached ? { reused: { workspaces: reused, of: parts.length } } : {}) };
};

export const repoGraph = (root: string, workspaces: readonly Workspace[] = WORKSPACES, detail: Detail = {}): Graph => builtGraph(root, workspaces, detail).graph;
