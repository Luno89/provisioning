import type { Layer } from '../lib/timings.js';

export function filesListed(layer: Layer, output: string): string[] {
  const prefix = `[${layer}] `;
  return output.split('\n').filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length).trim());
}

export function workspacesWithFiles<W extends { name: string }>(workspaces: readonly W[], listed: ReadonlyMap<string, readonly string[]>): W[] {
  return workspaces.filter((workspace) => (listed.get(workspace.name)?.length ?? 0) > 0);
}

export const noFilesIn = (layer: Layer): string => `no workspace has a file of the ${layer} layer, and no layer passes on no files`;

export interface TestedWorkspace { name: string; folder: string }

export function testedWorkspaces(globs: readonly string[], dirsIn: (dir: string) => string[], hasConfig: (folder: string) => boolean): TestedWorkspace[] {
  return globs.flatMap((glob) => {
    const matched = /^([^*]+)\/\*$/.exec(glob);
    if (!matched) throw new Error(`the workspace pattern ${glob} is not <folder>/*, which is all a layer knows how to read`);
    const parent = matched[1]!;
    return dirsIn(parent).sort().map((dir) => ({ name: dir, folder: `${parent}/${dir}` })).filter((workspace) => hasConfig(workspace.folder));
  });
}
