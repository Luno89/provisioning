import { describe, expect, it } from 'vitest';
import { registrySettingsFrom } from './registry-settings.js';

const GIVEN = { KOALA_REGISTRY: '127.0.0.1:31737', KOALA_REGISTRY_PUSH: 'gitea-http.gitea.svc.cluster.local:3000' };

describe('the registry workspace images are kept in', () => {
  it('is pulled from where the chart says a cluster pulls, and pushed where it says this process pushes', () => {
    expect(registrySettingsFrom(GIVEN)).toEqual({ pull: '127.0.0.1:31737', push: 'gitea-http.gitea.svc.cluster.local:3000' });
  });

  it.each([
    [{}, 'KOALA_REGISTRY, KOALA_REGISTRY_PUSH are not set'],
    [{ KOALA_REGISTRY: GIVEN.KOALA_REGISTRY }, 'KOALA_REGISTRY_PUSH is not set'],
    [{ ...GIVEN, KOALA_REGISTRY: ' ' }, 'KOALA_REGISTRY is not set'],
  ])('stops the process naming every setting missing: %j', (env, said) => {
    expect(() => registrySettingsFrom(env)).toThrow(`The registry workspace images are kept in is not set up: ${said}`);
  });

  it('refuses one that is not a host and port, naming it', () => {
    expect(() => registrySettingsFrom({ ...GIVEN, KOALA_REGISTRY: 'http://127.0.0.1:31737' })).toThrow('KOALA_REGISTRY is not a host and port: http://127.0.0.1:31737');
    expect(() => registrySettingsFrom({ ...GIVEN, KOALA_REGISTRY_PUSH: 'gitea-http' })).toThrow('KOALA_REGISTRY_PUSH is not a host and port: gitea-http');
  });
});
