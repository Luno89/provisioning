import { describe, expect, it } from 'vitest';
import { pinnedImage } from './pinned-image.js';

const pins = JSON.stringify({ components: [
  { kind: 'image', name: 'temporalio/admin-tools', version: '1.32.2', sha256: 'a'.repeat(64), source: 'docker.io/temporalio/admin-tools:1.32.2' },
  { kind: 'binary', name: 'k3s', version: 'v1.31.0+k3s1' },
] });

describe('an image the pins file pins', () => {
  it('is named by its version and digest, so the image pulled is the one pinned', () => {
    expect(pinnedImage('temporalio/admin-tools', pins)).toBe(`temporalio/admin-tools:1.32.2@sha256:${'a'.repeat(64)}`);
  });

  it('refuses a name the pins file pins as no image, saying so', () => {
    expect(() => pinnedImage('k3s', pins)).toThrow('dependencies.pins.json pins no image named k3s');
    expect(() => pinnedImage('nobody/nothing', pins)).toThrow('dependencies.pins.json pins no image named nobody/nothing');
  });
});
