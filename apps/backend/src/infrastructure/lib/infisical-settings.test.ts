import { describe, expect, it } from 'vitest';
import { infisicalSettingsFrom } from './infisical-settings.js';

describe('the setting a process reaches Infisical with', () => {
  it('reads the address the chart gives', () => {
    expect(infisicalSettingsFrom({ INFISICAL_URL: 'http://infisical-infisical-standalone-infisical.infisical.svc.cluster.local:8080/' })).toEqual({ url: 'http://infisical-infisical-standalone-infisical.infisical.svc.cluster.local:8080' });
  });

  it.each([{}, { INFISICAL_URL: '' }, { INFISICAL_URL: '  ' }])('stops the process naming it when it is missing: %j', (env) => {
    expect(() => infisicalSettingsFrom(env)).toThrow('Infisical, where projects\' secrets are kept, is not set up: INFISICAL_URL is not set');
  });

  it('refuses an address that is not one', () => {
    expect(() => infisicalSettingsFrom({ INFISICAL_URL: '127.0.0.1:31738' })).toThrow('INFISICAL_URL is not an address: 127.0.0.1:31738');
    expect(() => infisicalSettingsFrom({ INFISICAL_URL: 'http://vault:8080/api' })).toThrow('INFISICAL_URL has a path');
  });
});
