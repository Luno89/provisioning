import { describe, expect, it } from 'vitest';
import { BASES } from '@koala/agent-engine';
import { offers, planServerImage, runsFingerprint, serverProblems, serverState, usable, type McpServerRecord } from './mcp-servers.js';
import { PLAYWRIGHT } from '../extensions/mcp/templates.js';
import { SHIPPED_DEPENDENCIES } from '../extensions/workspace-dependencies.js';

const server = (over: Partial<McpServerRecord> = {}): McpServerRecord => ({
  id: 's1', ownerId: 'u1', name: 'playwright', runs: PLAYWRIGHT.runs, createdAt: 't0', updatedAt: 't0', ...over,
});
const captured = (runs = PLAYWRIGHT.runs, at = '2026-10-12T10:00:00Z') => ({ tools: [{ name: 'browser_navigate' }, { name: 'browser_take_screenshot' }], at, fingerprint: runsFingerprint(runs) });

describe('a server in the catalogue', () => {
  it('has a name its tools can be prefixed with, one of its own, and a way to run that makes sense', () => {
    expect(serverProblems(server())).toEqual([]);
    expect(serverProblems(server({ name: 'Play Wright' }))[0]).toContain('lowercase');
    expect(serverProblems(server(), [{ id: 's2', name: 'playwright' }])).toEqual(['you already have a server called playwright']);
    expect(serverProblems(server(), [{ id: 's1', name: 'playwright' }], 's1')).toEqual([]);
    expect(serverProblems(server({ runs: { where: 'hosted', url: 'ftp://x' } }))).toEqual(['a hosted server\'s URL has to be http or https']);
    expect(serverProblems(server({ runs: { where: 'workspace', needs: [], start: '', port: 80 } }))).toEqual([
      'a workspace server has to name the dependencies that install it', 'say the command that starts the server', 'the port has to be a whole number from 1024 to 65535',
    ]);
    expect(serverProblems(server({ offer: ['a'], omit: ['b'] }))).toEqual(['say which tools to offer or which to omit, not both']);
  });

  it('is usable once captured as it runs now, and not after a newer capture of the same failed', () => {
    expect(usable(server())).toBe(false);
    expect(usable(server({ captured: captured() }))).toBe(true);
    expect(usable(server({ captured: captured({ where: 'hosted', url: 'http://old.test/mcp' }) }))).toBe(false);
    expect(usable(server({ captured: captured(), failed: { at: '2026-10-12T11:00:00Z', why: 'x', fingerprint: runsFingerprint(PLAYWRIGHT.runs) } }))).toBe(false);
    expect(usable(server({ captured: captured(), capturing: { runId: 'r', at: 't' } }))).toBe(true);
  });

  it('says how far it has got, counting only the tools it offers', () => {
    expect(serverState(server())).toEqual({ state: 'new' });
    expect(serverState(server({ capturing: { runId: 'r', at: 't' } }))).toEqual({ state: 'capturing', runId: 'r' });
    expect(serverState(server({ captured: captured(), omit: ['browser_take_screenshot'] }))).toEqual({ state: 'captured', tools: 1 });
    expect(serverState(server({ captured: captured({ where: 'hosted', url: 'http://old.test/mcp' }) }))).toEqual({ state: 'stale' });
    expect(serverState(server({ failed: { at: 't', why: 'no node', fingerprint: runsFingerprint(PLAYWRIGHT.runs) } }))).toEqual({ state: 'failed', why: 'no node' });
    expect(offers({ omit: ['x'] }, 'x')).toBe(false);
    expect(offers({ offer: ['y'] }, 'x')).toBe(false);
  });

  it('plans the smallest workspace that has what a workspace server needs, each line saying it is the server\'s', () => {
    const plan = planServerImage(PLAYWRIGHT.runs as never, 'playwright', BASES, SHIPPED_DEPENDENCIES);
    expect(plan.base).toContain('nodejs');
    expect(plan.lines!.map((line) => [line.dependency, line.install.via, line.from])).toEqual([
      ['chromium-libraries', 'script', 'server:playwright'], ['playwright-mcp', 'npm', 'server:playwright'], ['playwright-mcp', 'script', 'server:playwright'],
    ]);
    const fetcher = { name: 'fetch-server', summary: 'fetch.', provides: ['mcp-server-fetch'], install: [{ via: 'pip' as const, packages: ['mcp-server-fetch'] }] };
    expect(planServerImage({ where: 'workspace', languages: ['python'], needs: ['fetch-server'], start: 'mcp-server-fetch', port: 9000 }, 'fetch', BASES, [...SHIPPED_DEPENDENCIES, fetcher]).base).toContain('python');
    expect(() => planServerImage({ where: 'workspace', needs: ['ffmpeg'], start: 'x', port: 9000 }, 'x', BASES, SHIPPED_DEPENDENCIES)).toThrow('server:x needs "ffmpeg", which no dependency is called');
  });
});
