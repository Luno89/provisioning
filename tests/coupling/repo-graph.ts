import { buildGraph, isTest, type Graph } from './graph.js';
import { MATCHES, outsideEnds, projectsOf, WORKSPACES, workspaceOf, type Workspace } from './workspaces.js';

export const repoGraph = (root: string, workspaces: readonly Workspace[] = WORKSPACES, detail: { withinFiles?: boolean } = {}): Graph =>
  buildGraph({ projects: projectsOf(root, workspaces), root, matches: MATCHES, extraEnds: outsideEnds(root), calledFrom: (file) => !isTest(file) && workspaceOf(file) !== undefined, ...detail });
