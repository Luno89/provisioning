import { describe, it, expect } from 'vitest';
import { imageForLanguage, capableImage } from './workspace-image-catalogue.js';
import { WORKSPACE_IMAGE_SEEDS as IMAGES } from './workspace-image-seeds.js';
import { seedsByLanguage as BY_LANGUAGE } from './workspace-image-seeds.js';

describe('choosing an image for what the work needs', () => {
  it('leaves the declared language alone when it can already do the job', () => {
    expect(capableImage(IMAGES, 'node', ['git'])).toBe(BY_LANGUAGE.node.image);
    expect(capableImage(IMAGES, 'python', ['git'])).toBe(BY_LANGUAGE.python.image);
  });

  it('keeps the minimal image when nothing extra is required', () => {
    expect(capableImage(IMAGES, 'base', [])).toBe(BY_LANGUAGE.base.image);
  });

  it('upgrades away from an image that cannot do what is asked', () => {
    expect(BY_LANGUAGE.base.absent).toContain('git');
    expect(capableImage(IMAGES, 'base', ['git'])).not.toBe(BY_LANGUAGE.base.image);
  });

  it('upgrades to an image that really has the requirement', () => {
    const chosen = capableImage(IMAGES, 'base', ['git']);
    const entry = Object.values(BY_LANGUAGE).find((i) => i.image === chosen)!;
    expect(entry.absent).not.toContain('git');
  });

  it('falls back to the declared language when nothing satisfies the requirement', () => {
    expect(capableImage(IMAGES, 'base', ['fortran'])).toBe(BY_LANGUAGE.base.image);
  });

  it('still answers for an unknown language the way it always did', () => {
    expect(capableImage(IMAGES, undefined, ['git'])).toBe(imageForLanguage(IMAGES, undefined));
  });
});
