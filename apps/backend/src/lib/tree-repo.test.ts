import { describe, it, expect } from 'vitest';
import { usesRepo, personaWorkspace } from './persona-scope.js';
import { primaryProjectId, withProject } from './trees.js';
import { inRepo, REPO_MOUNT } from './leaf-checkout.js';
import { WORKSPACE_IMAGES } from './workspace-spec.js';
import type { Persona } from '@koala/harness-types';
import type { Tree } from './trees.js';

/**
 * ── THE REPOSITORY BELONGS TO THE TREE ──
 *
 * A research leaf had nowhere durable to put anything: its deliverable was a capped database field,
 * and a finished playbook was persisted at exactly 20,000 characters, cut mid-URL, with the rest
 * destroyed alongside the pod.
 *
 * What decides behaviour is the persona RECORD, not a branch in the harness: `scope.repo` says
 * whether there is a checkout, and `scope.output` says whether the work is a document or code. Both
 * are editable in the Lab, which is the point — a persona is configured, not special-cased.
 */

const persona = (scope: Partial<NonNullable<Persona['scope']>> = {}): Persona => ({
  id: 'p1', ownerId: 'u1', name: 'P', systemPrompt: '', scope: { ...scope },
} as Persona);

describe('what the record decides', () => {
  it('gives a checkout to whatever declares one, document or code', () => {
    // Same field, same meaning as its name: does this persona work in the repository.
    expect(usesRepo(persona({ repo: true, output: '/work/repo/findings.md' }))).toBe(true);
    expect(usesRepo(persona({ repo: true }))).toBe(true);
  });

  it('treats an absent repo flag as no', () => {
    // Unchanged: "A repository is something a persona asks for."
    expect(usesRepo(persona({}))).toBe(false);
    expect(usesRepo(null)).toBe(false);
  });

  it('separates producing a document from producing code, by the output field', () => {
    /**
     * `scope.output` is what decides verification: a persona that names a deliverable is judged by
     * `assessFindings`, one that does not gets a test run and a Dockerfile check. So a document
     * persona can hold a repository without being handed a test suite it will never have — the
     * regression `usesRepo`'s own comment records.
     */
    const document = persona({ repo: true, output: '/work/repo/findings.md' });
    const code = persona({ repo: true });

    expect(Boolean(document.scope?.output)).toBe(true);
    expect(Boolean(code.scope?.output)).toBe(false);
  });
});

describe('one repository per effort', () => {
  const tree = (over: Partial<Tree> = {}): Tree => ({
    id: 't1', ownerId: 'u1', name: 'Effort', createdAt: '', updatedAt: '', ...over,
  } as Tree);

  it('hands every leaf of a tree the same project', () => {
    // The answer to "27 projects of which 26 never built": an effort has ONE repository.
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
  /**
   * Used by the persona migration, not by the harness at run time. The record ends up holding the
   * real path, so what the Lab shows and what the run uses are the same string.
   */
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
    /**
     * Not enforced in code — the migration moves document personas off it. Asserted so that the
     * fact stays true: if `base` ever gains git, the migration is no longer needed and this fails.
     */
    expect(WORKSPACE_IMAGES.base.absent).toContain('git');
    expect(WORKSPACE_IMAGES.node.available.some((t) => t.startsWith('git'))).toBe(true);
  });
});

describe('the image a checkout needs', () => {
  const prose = { id: 'p', ownerId: 'u1', name: 'Researcher', systemPrompt: '', scope: { language: 'base' } } as never;
  const ids = { leafId: 'l1', ownerId: 'u1' };

  it('gives a prose leaf with a checkout an image that can clone', () => {
    /**
     * The persona and the type both honestly say `base` — prose needs no toolchain. Cloning is a
     * requirement of the CHECKOUT, satisfied from the image catalogue rather than by making a
     * research project claim to be a Node project.
     */
    const spec = personaWorkspace(prose, ids, { requires: ['git'] });
    expect(spec.image).not.toBe(WORKSPACE_IMAGES.base.image);
  });

  it('leaves a leaf with no checkout on the minimal image', () => {
    expect(personaWorkspace(prose, ids, {}).image).toBe(WORKSPACE_IMAGES.base.image);
  });

  it('never overrides a toolchain the work actually needs', () => {
    // A Go repository needs Go whichever persona is standing in it, and git comes with it anyway.
    expect(personaWorkspace(prose, ids, { requires: ['git'], language: 'go' }).image)
      .toBe(WORKSPACE_IMAGES.go.image);
  });
});
