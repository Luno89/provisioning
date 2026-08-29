import { describe, it, expect } from 'vitest';
import { imageForLanguage, capableImage, WORKSPACE_IMAGES } from './workspace-spec.js';

describe('choosing an image for what the work needs', () => {
  it('leaves the declared language alone when it can already do the job', () => {
    expect(capableImage('node', ['git'])).toBe(WORKSPACE_IMAGES.node.image);
    expect(capableImage('python', ['git'])).toBe(WORKSPACE_IMAGES.python.image);
  });

  it('keeps the minimal image when nothing extra is required', () => {
    expect(capableImage('base', [])).toBe(WORKSPACE_IMAGES.base.image);
  });

  it('upgrades away from an image that cannot do what is asked', () => {
    expect(WORKSPACE_IMAGES.base.absent).toContain('git');
    expect(capableImage('base', ['git'])).not.toBe(WORKSPACE_IMAGES.base.image);
  });

  it('upgrades to an image that really has the requirement', () => {
    const chosen = capableImage('base', ['git']);
    const entry = Object.values(WORKSPACE_IMAGES).find((i) => i.image === chosen)!;
    expect(entry.absent).not.toContain('git');
  });

  it('falls back to the declared language when nothing satisfies the requirement', () => {
    expect(capableImage('base', ['fortran'])).toBe(WORKSPACE_IMAGES.base.image);
  });

  it('still answers for an unknown language the way it always did', () => {
    expect(capableImage(undefined, ['git'])).toBe(imageForLanguage(undefined));
  });
});
