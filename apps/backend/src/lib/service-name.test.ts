import { describe, it, expect } from 'vitest';
import { serviceNameFor, toServiceSlug, isGeneratedName, usableServiceName } from './service-name.js';

describe('spotting a name that is really an id', () => {
  it('recognises the platform\'s generated form', () => {
    expect(isGeneratedName('koala-request-42784df9')).toBe(true);
    expect(isGeneratedName('koala-request-d07a5dcf')).toBe(true);
  });

  it('does not mistake a real name for one', () => {
    expect(isGeneratedName('Weather API MCP')).toBe(false);
    expect(isGeneratedName('koala-registry')).toBe(false);
    expect(isGeneratedName('mcp-github-server')).toBe(false);
  });

  it('treats a missing name as generated, so it is never chosen', () => {
    expect(isGeneratedName(undefined)).toBe(true);
    expect(isGeneratedName('  ')).toBe(true);
  });
});

describe('turning a name into a prefix', () => {
  it('makes an ordinary name safe', () => {
    expect(toServiceSlug('Weather API MCP')).toBe('weather-api-mcp');
    expect(toServiceSlug('GitHub MCP Server')).toBe('github-mcp-server');
  });

  it('caps the length, because the prefix is read before the tool name', () => {
    const long = toServiceSlug('An Extremely Long Project Name That Someone Typed In Full');
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long.endsWith('-')).toBe(false);
  });

  it('never produces an empty prefix', () => {
    expect(toServiceSlug('!!!')).toBe('service');
  });
});

describe('choosing which name to use', () => {
  const base = { deploymentName: 'koala-request-42784df9' };

  it('prefers what the planner declared', () => {
    expect(serviceNameFor({ ...base, declared: 'weather', treeName: 'Weather API MCP' })).toBe('weather');
  });

  it('falls back to the tree name, which a person chose', () => {
    expect(serviceNameFor({ ...base, treeName: 'Weather API MCP' })).toBe('weather-api-mcp');
  });

  it('skips a project name that is really an id', () => {
    expect(serviceNameFor({ ...base, treeName: 'Weather API MCP', projectName: 'koala-request-42784df9' }))
      .toBe('weather-api-mcp');
  });

  it('uses a real project name when there is no tree', () => {
    expect(serviceNameFor({ ...base, projectName: 'mcp-github-server' })).toBe('mcp-github-server');
  });

  it('falls all the way back to the id rather than inventing something', () => {
    expect(serviceNameFor(base)).toBe('koala-request-42784df9');
  });
});

describe('accepting what the planner says', () => {
  it('takes a short name', () => {
    expect(usableServiceName('weather')).toBe('weather');
    expect(usableServiceName('  github-api  ')).toBe('github-api');
  });

  it('rejects a sentence', () => {
    expect(usableServiceName('the service that wraps the GitHub REST API')).toBeUndefined();
    expect(usableServiceName('a'.repeat(60))).toBeUndefined();
  });

  it('rejects a generated id offered as a name', () => {
    expect(usableServiceName('koala-request-42784df9')).toBeUndefined();
  });

  it('rejects anything that is not a string', () => {
    for (const bad of [undefined, null, 42, {}, []]) expect(usableServiceName(bad)).toBeUndefined();
  });
});
