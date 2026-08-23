import { describe, it, expect } from 'vitest';
import { imageForLanguage, capableImage, WORKSPACE_IMAGES } from './workspace-spec.js';

/**
 * ── WHY A TYPE DOES NOT SAY "NODE" TO MEAN "NEEDS GIT" ──
 *
 * A research paper is prose. Its honest language is `base` — "shell and text editing only" — and the
 * catalogue says so. But every tree takes a checkout now, and `base` has no git, so the seeds were
 * quietly changed to `node`: encoding "must be able to clone" as "is a Node project".
 *
 * That is the wrong field. The requirement belongs to the CHECKOUT, and the catalogue already
 * declares which images can satisfy it — every entry lists what it is `absent`. So the rule is data,
 * not a name: start from the language the work asked for, and if it cannot do what the workspace
 * needs, take the smallest one that can.
 */

describe('choosing an image for what the work needs', () => {
  it('leaves the declared language alone when it can already do the job', () => {
    expect(capableImage('node', ['git'])).toBe(WORKSPACE_IMAGES.node.image);
    expect(capableImage('python', ['git'])).toBe(WORKSPACE_IMAGES.python.image);
  });

  it('keeps the minimal image when nothing extra is required', () => {
    // A leaf with no checkout — a Reviewer, a Judge — should still get the smallest thing that runs
    // a shell. Prose needs no compiler, and that was always the right call.
    expect(capableImage('base', [])).toBe(WORKSPACE_IMAGES.base.image);
  });

  it('upgrades away from an image that cannot do what is asked', () => {
    /**
     * `base` declares `absent: ['git', ...]`. Read, not hardcoded: if someone adds git to that image
     * tomorrow, this stops upgrading on its own.
     */
    expect(WORKSPACE_IMAGES.base.absent).toContain('git');
    expect(capableImage('base', ['git'])).not.toBe(WORKSPACE_IMAGES.base.image);
  });

  it('upgrades to an image that really has the requirement', () => {
    const chosen = capableImage('base', ['git']);
    const entry = Object.values(WORKSPACE_IMAGES).find((i) => i.image === chosen)!;
    expect(entry.absent).not.toContain('git');
  });

  it('falls back to the declared language when nothing satisfies the requirement', () => {
    // Better to build the workspace the work asked for and fail at the command than to substitute
    // an unrelated toolchain because of a requirement no image lists.
    expect(capableImage('base', ['fortran'])).toBe(WORKSPACE_IMAGES.base.image);
  });

  it('still answers for an unknown language the way it always did', () => {
    expect(capableImage(undefined, ['git'])).toBe(imageForLanguage(undefined));
  });
});
