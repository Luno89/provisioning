import { describe, it, expect } from 'vitest';
import { executeTool, type ToolDefinition } from './tool-exec.js';

describe('a tool whose implementation is the command it declares', () => {
  const counter = {
    name: 'count_lines',
    description: 'Counts matching lines',
    binding: 'environment' as const,
    command: 'rg --count {pattern} {path}',
    parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'what to look for' }, path: { type: 'string', description: 'where' } } },
  };

  const driverThatReports = (seen: string[]) => ({
    handle: () => ({ id: 'sandbox-1', capabilities: { terminal: true, filesystem: true } }),
    exec: async ({ command }: { command: string }) => {
      seen.push(command);
      return { stdout: '12', stderr: '', exitCode: 0 };
    },
    readFile: async () => '',
    writeFile: async () => undefined,
    listDir: async () => [],
    deleteFile: async () => undefined,
  });

  it('runs the command with the arguments quoted into it', async () => {
    const seen: string[] = [];
    const outcome = await executeTool({
      name: 'count_lines',
      arguments: JSON.stringify({ pattern: 'todo', path: 'src' }),
      granted: ['count_lines'],
      catalogue: [counter],
      driver: driverThatReports(seen) as never,
    });

    expect(seen).toEqual(["rg --count 'todo' 'src'"]);
    expect(outcome).toMatchObject({ ok: true, content: '12' });
  });

  it('gives an argument no way to become a second command', async () => {
    const seen: string[] = [];
    await executeTool({
      name: 'count_lines',
      arguments: JSON.stringify({ pattern: 'x', path: 'src; rm -rf /' }),
      granted: ['count_lines'],
      catalogue: [counter],
      driver: driverThatReports(seen) as never,
    });

    expect(seen).toEqual(["rg --count 'x' 'src; rm -rf /'"]);
  });

  it('still refuses a tool that declares no command and has no handler', async () => {
    const outcome = await executeTool({
      name: 'mystery',
      arguments: '{}',
      granted: ['mystery'],
      catalogue: [{ name: 'mystery', description: 'nothing', binding: 'environment' as const }],
      driver: driverThatReports([]) as never,
    });

    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.digest).toContain('no implementation here');
  });
});

describe('a peer refusing a call', () => {
  const definition: ToolDefinition = {
    name: 'fetch_web_page',
    description: 'Fetches a page',
    binding: 'handler' as const,
    parameters: { type: 'object', properties: {} },
  };

  const base = {
    arguments: '{}',
    granted: ['fetch_web_page'],
    catalogue: [definition],
    caller: { ownerId: 'user-1', runId: 'run-1', agentSlug: 'koala' },
    digestChars: 256,
  };

  it('carries the refusal past the boundary as a marker, not a crash', async () => {
    const refused = async () => ({ ok: false, digest: 'HTTP 403: this site refused the fetch', declined: true });

    const outcome = await executeTool({ ...base, name: 'fetch_web_page', handlers: { fetch_web_page: refused } });

    expect(outcome).toMatchObject({ ok: false, declined: true, digest: 'HTTP 403: this site refused the fetch' });
  });

  it('leaves an ordinary failure unmarked', async () => {
    const crashed = async () => ({ ok: false, digest: 'HTTP error 500' });

    const outcome = await executeTool({ ...base, name: 'fetch_web_page', handlers: { fetch_web_page: crashed } });

    expect(outcome.ok).toBe(false);
    expect(outcome.declined).toBeUndefined();
  });
});
