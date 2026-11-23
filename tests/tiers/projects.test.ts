import { matchesGlob } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tiers } from './projects.js';

const names = ['unit', 'component', 'contract', 'container', 'integration'];
const pattern = (kind: string): string => `src/a/b.${kind}.test.ts`;

describe('the projects a workspace gets', () => {
  const projects = tiers({ include: ['src/**/*.test.ts'] });
  const kinds = [['component', 'component'], ['contract', 'contract'], ['container', 'container'], ['integration', 'integration'], ['real-minio', 'integration']] as const;

  it('are one per layer', () => {
    expect(projects.map((project) => project.test?.name)).toEqual(names);
  });

  it.each(kinds)('take a *.%s.test file in exactly one project', (kind, project) => {
    const file = pattern(kind);
    const owners = projects.filter((one) => matches(one.test?.include ?? [], file) && !matches(one.test?.exclude ?? [], file)).map((one) => one.test?.name);
    expect(owners).toEqual([project]);
  });

  it.each([['unit', 'unit-guard.ts'], ['component', 'component-guard.ts'], ['contract', 'contract-guard.ts'], ['container', 'container-guard.ts']])('hold the %s layer to its own guard', (name, guard) => {
    const setup = projects.find((one) => one.test?.name === name)?.test?.setupFiles;
    expect((Array.isArray(setup) ? setup : []).filter((file) => file.endsWith('-guard.ts')).map((file) => file.split('/').pop())).toEqual([guard]);
  });

  it('give a plain *.test file to unit alone', () => {
    const owners = projects.filter((one) => matches(one.test?.include ?? [], pattern('unit').replace('.unit', '')) && !matches(one.test?.exclude ?? [], pattern('unit').replace('.unit', ''))).map((one) => one.test?.name);
    expect(owners).toEqual(['unit']);
  });
});

const matches = (globs: string[], file: string): boolean => globs.some((glob) => matchesGlob(file, glob));
