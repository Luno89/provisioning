import { describe, it, expect } from 'vitest';
import { environmentHandlers, executeTool, type ToolDefinition } from './tool-exec.js';

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

describe('what the model is told after changing a file', () => {
  const driver = {
    handle: () => ({ id: 'sandbox-1', capabilities: { terminal: true, filesystem: true } }),
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    readFile: async () => '',
    writeFile: async () => undefined,
    listDir: async () => [],
    deleteFile: async () => undefined,
  };

  it('says what was written and where, rather than nothing', async () => {
    const written = await environmentHandlers.write_file!({ parsed: { path: 'findings.md', content: 'hello' }, driver } as never);
    expect(written).toMatchObject({ ok: true, content: 'wrote 5 bytes to findings.md' });

    const deleted = await environmentHandlers.delete_file!({ parsed: { path: 'old.md' }, driver } as never);
    expect(deleted).toMatchObject({ ok: true, content: 'deleted old.md' });
  });

  it('writes content that arrives as JSON data out as JSON, rather than an empty file', async () => {
    const files: Record<string, string> = {};
    const keeping = { ...driver, writeFile: async (path: string, text: string) => { files[path] = text; } };
    const written = await environmentHandlers.write_file!({ parsed: { path: 'branches.json', content: [{ title: 'a', leaves: [] }] }, driver: keeping } as never);

    expect(files['branches.json']).toBe(`${JSON.stringify([{ title: 'a', leaves: [] }], null, 2)}\n`);
    expect(written).toMatchObject({ ok: true, content: expect.stringContaining('content arrived as JSON data, so it was written out as JSON') });
  });

  it('refuses rather than writing an empty file when there is no content', async () => {
    const files: Record<string, string> = {};
    const keeping = { ...driver, writeFile: async (path: string, text: string) => { files[path] = text; } };
    expect(await environmentHandlers.write_file!({ parsed: { path: 'x.md' }, driver: keeping } as never)).toMatchObject({ ok: false, content: 'nothing was written — content has to be the text to write into the file' });
    expect(await environmentHandlers.write_file!({ parsed: { path: 'x.md', content: '' }, driver: keeping } as never)).toMatchObject({ ok: true });
    expect(files).toEqual({ 'x.md': '' });
  });
});
