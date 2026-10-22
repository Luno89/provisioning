import { describe, it, expect } from 'vitest';
import { validatePipelineConfig, parsePipelineConfig, buildArgEntries } from './pipeline-config.js';

describe('validatePipelineConfig', () => {
  it('accepts an empty object', () => {
    expect(validatePipelineConfig({})).toBeNull();
  });

  it('accepts a full config', () => {
    expect(validatePipelineConfig({
      dockerfile: 'docker/Dockerfile', context: 'services/api', buildArgs: { NODE_ENV: 'production', PORT: 8080 },
    })).toBeNull();
  });

  it('rejects a non-object top level', () => {
    expect(validatePipelineConfig('just a string')).toMatch(/mapping/);
    expect(validatePipelineConfig(['a', 'b'])).toMatch(/mapping/);
    expect(validatePipelineConfig(null)).toMatch(/mapping/);
  });

  it('rejects an empty dockerfile', () => {
    expect(validatePipelineConfig({ dockerfile: '' })).toMatch(/dockerfile/);
  });

  it('rejects a dockerfile path that escapes the repo', () => {
    expect(validatePipelineConfig({ dockerfile: '/etc/passwd' })).toMatch(/dockerfile/);
    expect(validatePipelineConfig({ dockerfile: '../../etc/passwd' })).toMatch(/dockerfile/);
  });

  it('rejects a context path that escapes the repo', () => {
    expect(validatePipelineConfig({ context: '../outside' })).toMatch(/context/);
  });

  it('rejects a non-mapping buildArgs', () => {
    expect(validatePipelineConfig({ buildArgs: ['a', 'b'] })).toMatch(/buildArgs/);
    expect(validatePipelineConfig({ buildArgs: 'x' })).toMatch(/buildArgs/);
  });

  it('rejects a buildArgs key that is not a valid identifier', () => {
    expect(validatePipelineConfig({ buildArgs: { 'not valid': 'x' } })).toMatch(/buildArgs key/);
    expect(validatePipelineConfig({ buildArgs: { '1START': 'x' } })).toMatch(/buildArgs key/);
  });

  it('rejects a buildArgs value that is not a scalar', () => {
    expect(validatePipelineConfig({ buildArgs: { KEY: { nested: true } } })).toMatch(/buildArgs\.KEY/);
  });
});

describe('parsePipelineConfig', () => {
  it('parses valid YAML into a config object', () => {
    const { config, error } = parsePipelineConfig('dockerfile: docker/Dockerfile\ncontext: services/api\n');
    expect(error).toBeNull();
    expect(config).toEqual({ dockerfile: 'docker/Dockerfile', context: 'services/api' });
  });

  it('treats an empty file as an empty config, not an error', () => {
    const { config, error } = parsePipelineConfig('');
    expect(error).toBeNull();
    expect(config).toEqual({});
  });

  it('returns an error, not a throw, for malformed YAML', () => {
    const { config, error } = parsePipelineConfig('dockerfile: ["unclosed');
    expect(config).toBeNull();
    expect(error).toMatch(/could not parse/);
  });

  it('returns an error, not a throw, for a value that parses but fails validation', () => {
    const { config, error } = parsePipelineConfig('dockerfile: ../../etc/passwd\n');
    expect(config).toBeNull();
    expect(error).toMatch(/dockerfile/);
  });

  it('parses nested buildArgs', () => {
    const { config, error } = parsePipelineConfig('buildArgs:\n  NODE_ENV: production\n  PORT: 8080\n');
    expect(error).toBeNull();
    expect(config?.buildArgs).toEqual({ NODE_ENV: 'production', PORT: 8080 });
  });
});

describe('buildArgEntries', () => {
  it('is empty for no config', () => {
    expect(buildArgEntries(null)).toEqual([]);
    expect(buildArgEntries({})).toEqual([]);
  });

  it('stringifies non-string values', () => {
    expect(buildArgEntries({ buildArgs: { PORT: 8080 as unknown as string, DEBUG: true as unknown as string } }))
      .toEqual([['PORT', '8080'], ['DEBUG', 'true']]);
  });
});
