import { describe, it, expect } from 'vitest';
import { serviceNameFor, toServiceSlug, isGeneratedName, usableServiceName } from './service-name.js';

/**
 * What a service is CALLED, as opposed to what Kubernetes calls it.
 *
 * ── THE OBSERVED PROBLEM ──
 * The deployment, its project and its repository were all named `koala-request-42784df9`, so every
 * tool the service exposed was prefixed with a hex id: `koala-request-42784df9__get-forecast`. The
 * one part of the name that should say what the thing IS said nothing. Meanwhile the tree had been
 * called "Weather API MCP" all along and nothing used it.
 */

describe('spotting a name that is really an id', () => {
  it('recognises the platform\'s generated form', () => {
    expect(isGeneratedName('koala-request-42784df9')).toBe(true);
    expect(isGeneratedName('koala-request-d07a5dcf')).toBe(true);
  });

  it('does not mistake a real name for one', () => {
    // The false positive would be expensive: a real name discarded in favour of a worse one.
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
    /**
     * A 60-character prefix on every tool in a list makes them near-impossible to tell apart at a
     * glance — which is the whole problem being fixed, in a different form.
     */
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
    // The most deliberate source available: something chose this on purpose, for this reason.
    expect(serviceNameFor({ ...base, declared: 'weather', treeName: 'Weather API MCP' })).toBe('weather');
  });

  it('falls back to the tree name, which a person chose', () => {
    /**
     * The actual fix. "Weather API MCP" was sitting on the tree the whole time while every tool was
     * prefixed with a request id.
     */
    expect(serviceNameFor({ ...base, treeName: 'Weather API MCP' })).toBe('weather-api-mcp');
  });

  it('skips a project name that is really an id', () => {
    // The project is named after the request too, so it must not be preferred over the tree.
    expect(serviceNameFor({ ...base, treeName: 'Weather API MCP', projectName: 'koala-request-42784df9' }))
      .toBe('weather-api-mcp');
  });

  it('uses a real project name when there is no tree', () => {
    expect(serviceNameFor({ ...base, projectName: 'mcp-github-server' })).toBe('mcp-github-server');
  });

  it('falls all the way back to the id rather than inventing something', () => {
    /**
     * When every name available is generated, the id is a bad name and an honest one. Inventing a
     * friendly name here would produce two services called `service` the moment there are two.
     */
    expect(serviceNameFor(base)).toBe('koala-request-42784df9');
  });
});

describe('accepting what the planner says', () => {
  it('takes a short name', () => {
    expect(usableServiceName('weather')).toBe('weather');
    expect(usableServiceName('  github-api  ')).toBe('github-api');
  });

  it('rejects a sentence', () => {
    /**
     * Asked for a short name, a model will sometimes answer with a description. Prefixing every
     * tool with that is worse than falling back to the tree name, which loses nothing.
     */
    expect(usableServiceName('the service that wraps the GitHub REST API')).toBeUndefined();
    expect(usableServiceName('a'.repeat(60))).toBeUndefined();
  });

  it('rejects a generated id offered as a name', () => {
    // A model echoing the request id back is not a decision.
    expect(usableServiceName('koala-request-42784df9')).toBeUndefined();
  });

  it('rejects anything that is not a string', () => {
    for (const bad of [undefined, null, 42, {}, []]) expect(usableServiceName(bad)).toBeUndefined();
  });
});
