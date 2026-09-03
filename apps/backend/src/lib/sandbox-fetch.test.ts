import { describe, it, expect } from 'vitest';
import { sandboxFetchRequest, parseSandboxFetchOutput } from './sandbox-fetch.js';

describe('sandboxFetchRequest', () => {
  it('defaults to GET with no headers or body', () => {
    expect(sandboxFetchRequest('http://127.0.0.1:8080/health')).toEqual({
      url: 'http://127.0.0.1:8080/health', method: 'GET', headersJson: '{}', body: '',
    });
  });

  it('carries method, headers and a string body through untouched', () => {
    const req = sandboxFetchRequest('http://127.0.0.1:8080/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0"}',
    });
    expect(req.method).toBe('POST');
    expect(JSON.parse(req.headersJson)).toEqual({ 'content-type': 'application/json' });
    expect(req.body).toBe('{"jsonrpc":"2.0"}');
  });

  it('never interpolates request content into a shell-shaped string', () => {
    const req = sandboxFetchRequest('http://x/mcp', { body: `"; rm -rf / #` });
    expect(req.body).toBe('"; rm -rf / #');
  });
});

describe('parseSandboxFetchOutput', () => {
  it('marks 2xx as ok and exposes the body via text()/json()', async () => {
    const res = parseSandboxFetchOutput(JSON.stringify({ status: 200, body: '{"result":{"protocolVersion":"x"}}' }));
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"result":{"protocolVersion":"x"}}');
    expect(await res.json()).toEqual({ result: { protocolVersion: 'x' } });
  });

  it('marks a non-2xx status as not ok', async () => {
    const res = parseSandboxFetchOutput(JSON.stringify({ status: 404, body: 'Not found' }));
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
  });

  it('throws when the sandboxed fetch itself failed (e.g. connection refused)', () => {
    expect(() => parseSandboxFetchOutput(JSON.stringify({ error: 'connect ECONNREFUSED 127.0.0.1:8080' })))
      .toThrow('connect ECONNREFUSED 127.0.0.1:8080');
  });

  it('treats empty output as a zero-status non-ok response rather than throwing', async () => {
    const res = parseSandboxFetchOutput('');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
  });
});
