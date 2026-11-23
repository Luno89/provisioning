import type { Layer } from '../lib/timings.js';
import type { Workspace } from '../coupling/workspaces.js';

export function filesListed(layer: Layer, output: string): string[] {
  const prefix = `[${layer}] `;
  return output.split('\n').filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length).trim());
}

export function workspacesWithFiles(workspaces: readonly Workspace[], listed: ReadonlyMap<string, readonly string[]>): Workspace[] {
  return workspaces.filter((workspace) => (listed.get(workspace.name)?.length ?? 0) > 0);
}

export const noFilesIn = (layer: Layer): string => `no workspace has a file of the ${layer} layer, and no layer passes on no files`;
