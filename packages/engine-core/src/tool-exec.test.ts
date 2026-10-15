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

describe('running a command', () => {
  const recording = (result: { stdout: string; stderr: string; exitCode: number; stopped?: 'timeout' | 'cancelled' } = { stdout: 'out', stderr: '', exitCode: 0 }) => {
    const seen: Record<string, unknown>[] = [];
    const driver = {
      handle: () => ({ id: 'sandbox-1', capabilities: { terminal: true, filesystem: true } }),
      exec: async (request: Record<string, unknown>) => { seen.push(request); return result; },
      readFile: async () => '',
      writeFile: async () => undefined,
      listDir: async () => [],
      deleteFile: async () => undefined,
    };
    return { seen, driver: driver as never };
  };
  const run = (driver: never, args: Record<string, unknown>, signal?: AbortSignal) => executeTool({
    name: 'run_command',
    arguments: JSON.stringify(args),
    granted: ['run_command'],
    catalogue: [{ name: 'run_command', description: 'run', binding: 'environment' as const, requires: { terminal: true } }],
    driver,
    ...(signal ? { signal } : {}),
  });

  it('lets it run until it ends unless the call sets timeoutSeconds, and hands it the run\'s stop', async () => {
    const { seen, driver } = recording();
    const stop = new AbortController();
    await run(driver, { command: 'npm test' }, stop.signal);
    await run(driver, { command: 'npm test', timeoutSeconds: 90 });
    await run(driver, { command: 'npm test', timeoutSeconds: '2.5' });

    expect(seen[0]).toEqual({ command: 'npm test', signal: stop.signal });
    expect(seen[1]).toEqual({ command: 'npm test', timeoutMs: 90_000 });
    expect(seen[2]).toEqual({ command: 'npm test', timeoutMs: 3_000 });
  });

  it('refuses a timeout that is not a positive number of seconds', async () => {
    const { seen, driver } = recording();
    for (const timeoutSeconds of [0, -5, 'soon']) {
      const outcome = await run(driver, { command: 'npm test', timeoutSeconds });
      expect(outcome.ok).toBe(false);
      expect(outcome.content).toContain('"timeoutSeconds" has to be a number of seconds above zero');
    }
    expect(seen).toEqual([]);
  });

  it('says when it was stopped, and why, and counts it as failed', async () => {
    const timedOut = await run(recording({ stdout: 'half', stderr: '', exitCode: 137, stopped: 'timeout' }).driver, { command: 'serve', timeoutSeconds: 5 });
    expect(timedOut).toMatchObject({ ok: false, content: 'half\n[stopped after 5s, the timeoutSeconds this call set; everything it started was stopped too]' });
    const cancelled = await run(recording({ stdout: '', stderr: '', exitCode: 0, stopped: 'cancelled' }).driver, { command: 'serve' });
    expect(cancelled).toMatchObject({ ok: false, content: '[stopped because the run was stopped; everything it started was stopped too]' });
  });
});
