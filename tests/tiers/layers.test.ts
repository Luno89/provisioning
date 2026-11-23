import { describe, expect, it } from 'vitest';
import { filesListed, noFilesIn, testedWorkspaces, workspacesWithFiles } from './layers.js';
import { WORKSPACES } from '../coupling/workspaces.js';

describe('the workspaces that have files of a layer', () => {
  it('reads the files vitest lists for the layer and no other line', () => {
    expect(filesListed('component', '[component] src/a.component.test.ts\n[contract] src/b.contract.test.ts\nnoise\n')).toEqual(['src/a.component.test.ts']);
  });

  it('keeps those with a file, in the order of WORKSPACES', () => {
    const listed = new Map([['engine-core', ['x']], ['backend', ['y']], ['frontend', []]]);
    expect(workspacesWithFiles(WORKSPACES, listed).map((workspace) => workspace.name)).toEqual(['backend', 'engine-core']);
  });

  it('says no layer passes on no files, naming the layer', () => {
    expect(workspacesWithFiles(WORKSPACES, new Map())).toEqual([]);
    expect(noFilesIn('contract')).toContain('contract');
  });
});

describe('the workspaces a layer runs in', () => {
  const folders: Record<string, string[]> = { apps: ['backend', 'frontend'], packages: ['coupling', 'harness-types'] };
  const configured = new Set(['apps/backend', 'apps/frontend', 'packages/coupling']);
  const found = testedWorkspaces(['apps/*', 'packages/*'], (dir) => folders[dir] ?? [], (folder) => configured.has(folder));

  it('are every npm workspace with a vitest config, coupling included', () => {
    expect(found.map((workspace) => workspace.folder)).toEqual(['apps/backend', 'apps/frontend', 'packages/coupling']);
  });

  it('are named by their folder', () => {
    expect(found.map((workspace) => workspace.name)).toEqual(['backend', 'frontend', 'coupling']);
  });

  it('refuse a workspace pattern they cannot read, naming it', () => {
    expect(() => testedWorkspaces(['tools/**'], () => [], () => true)).toThrow('tools/**');
  });
});
