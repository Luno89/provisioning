import { describe, it, expect } from 'vitest';
import { usesRepo, personaWorkspace } from './persona-scope.js';
import { primaryProjectId, withProject } from './trees.js';
import { inRepo, REPO_MOUNT } from './leaf-checkout.js';

import type { PersonaPack } from '@koala/harness-types';
import type { Tree } from './trees.js';
import type { TreeTypeSpec } from './tree-types.js';
import { WORKSPACE_IMAGE_SEEDS as IMAGES } from './workspace-image-seeds.js';
import { seedsByLanguage as BY_LANGUAGE } from './workspace-image-seeds.js';

const treeType = (produces?: TreeTypeSpec['produces']) =>
  ({ produces }) as Pick<TreeTypeSpec, 'produces'>;

const pack = (output?: string) => ({ id: 'p1', name: 'P', tools: [], output }) as unknown as PersonaPack;

describe('what the record decides', () => {
  it('gives a checkout to a service tree type, document or code pack', () => {
    expect(usesRepo(treeType('service'))).toBe(true);
  });

  it('treats an artefact tree type as no', () => {
    expect(usesRepo(treeType('artefact'))).toBe(false);
    expect(usesRepo(null)).toBe(false);
  });

  it('separates producing a document from producing code, by the pack\'s output field', () => {
    const document = pack('/work/repo/findings.md');
    const code = pack();

    expect(Boolean(document.output)).toBe(true);
    expect(Boolean(code.output)).toBe(false);
  });
});

describe('one repository per effort', () => {
  const tree = (over: Partial<Tree> = {}): Tree => ({
    id: 't1', ownerId: 'u1', name: 'Effort', createdAt: '', updatedAt: '', ...over,
  } as Tree);

  it('hands every leaf of a tree the same project', () => {
    const withOne = withProject(tree(), 'proj-1');
    expect(primaryProjectId(withOne)).toBe('proj-1');
    expect(primaryProjectId(withProject(withOne, 'proj-1'))).toBe('proj-1');
  });

  it('keeps the first project as primary when a second is added', () => {
    const two = withProject(withProject(tree(), 'proj-1'), 'proj-2');
    expect(two.projectIds).toEqual(['proj-1', 'proj-2']);
    expect(primaryProjectId(two)).toBe('proj-1');
  });

  it('has none before any leaf has run', () => {
    expect(primaryProjectId(tree())).toBeUndefined();
  });
});

describe('moving a deliverable into the checkout', () => {
  it('rebases a workspace path under the repository', () => {
    expect(inRepo('/work/findings.md')).toBe(`${REPO_MOUNT}/findings.md`);
  });

  it('accepts a bare filename', () => {
    expect(inRepo('findings.md')).toBe(`${REPO_MOUNT}/findings.md`);
  });

  it('is idempotent, so a migration that runs twice changes nothing', () => {
    expect(inRepo(inRepo('/work/findings.md'))).toBe(`${REPO_MOUNT}/findings.md`);
  });

  it('keeps a nested path', () => {
    expect(inRepo('/work/docs/report.md')).toBe(`${REPO_MOUNT}/docs/report.md`);
  });
});

describe('the image a cloning persona needs', () => {
  it('records that the minimal image cannot clone', () => {
    expect(BY_LANGUAGE.base.absent).toContain('git');
    expect(BY_LANGUAGE.node.available.some((t) => t.startsWith('git'))).toBe(true);
  });
});

describe('the image a checkout needs', () => {
  const ids = { leafId: 'l1', ownerId: 'u1' };

  it('gives a prose leaf with a checkout an image that can clone', () => {
    const spec = personaWorkspace(IMAGES, ids, { language: 'base', requires: ['git'] });
    expect(spec.image).not.toBe(BY_LANGUAGE.base.image);
  });

  it('leaves a leaf with no checkout on the minimal image', () => {
    expect(personaWorkspace(IMAGES, ids, { language: 'base' }).image).toBe(BY_LANGUAGE.base.image);
  });

  it('never overrides a toolchain the work actually needs', () => {
    expect(personaWorkspace(IMAGES, ids, { requires: ['git'], language: 'go' }).image)
      .toBe(BY_LANGUAGE.go.image);
  });
});
