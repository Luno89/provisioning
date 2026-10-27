import { describe, expect, it } from 'vitest';
import { LANGUAGE_DEPENDENCIES, dependencyProblems, isPackageName } from '@koala/agent-engine';
import { SHIPPED_DEPENDENCIES } from './workspace-dependencies.js';
import { WORKSPACE_BASES } from './workspace-bases.js';

describe('what Koala ships to build workspaces with', () => {
  it('names only packages a build will take, so no shipped dependency, language or base ever stops a build', () => {
    for (const dependency of [...SHIPPED_DEPENDENCIES, ...LANGUAGE_DEPENDENCIES]) expect(dependencyProblems(dependency), dependency.name).toEqual([]);
    for (const base of WORKSPACE_BASES) {
      for (const install of base.setup ?? []) {
        if (install.via === 'script' || install.via === 'base') continue;
        for (const name of install.packages) expect(isPackageName(install.via, name), `${base.id}: ${name}`).toBe(true);
      }
    }
  });
});
