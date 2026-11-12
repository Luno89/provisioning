import { describe, expect, it } from 'vitest';
import { wantedSetups } from './projects.js';

const optional = { k3s: { globalSetup: './k3s.ts', setupFiles: ['./check.ts'] }, minio: { globalSetup: './minio.ts' } };

describe('the optional setups an integration run starts', () => {
  it('starts every one when none are named, and only those named otherwise', () => {
    expect(wantedSetups(optional, undefined)).toEqual([optional.k3s, optional.minio]);
    expect(wantedSetups(optional, 'minio')).toEqual([optional.minio]);
    expect(wantedSetups(optional, '')).toEqual([]);
  });

  it('refuses a name the workspace does not set up', () => {
    expect(() => wantedSetups(optional, 'k3d')).toThrow('KOALA_SETUPS names k3d, which this workspace does not set up; it sets up k3s, minio');
  });
});
