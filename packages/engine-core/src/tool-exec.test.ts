import { describe, it, expect } from 'vitest';
import { executeTool } from './tool-exec.js';

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
