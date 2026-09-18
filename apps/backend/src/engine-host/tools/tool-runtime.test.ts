import { describe, it, expect, vi } from 'vitest';
import { createToolRuntime, type EnvironmentSource } from './tool-runtime.js';
import { createAgentRegistry } from '../registries/registry.js';
import { createSandboxDriver } from '../drivers/sandbox.js';
import { createNoneDriver } from '@koala/engine-core';
import type { ToolCallArgs } from '../temporal/contracts.js';
import type { EnvironmentDriver, EnvironmentSpec, ToolContract } from '@koala/engine-core';
import type { AgentDefinition } from '@koala/agent-engine';

const spec: EnvironmentSpec = { kind: 'sandbox', lifecycle: 'invocation', languages: ['node20'] };

const args = (over: Partial<ToolCallArgs> = {}): ToolCallArgs => ({
  ticket: { runId: 'run-1', depth: 0, ownerId: 'user-1', agentSlug: 'executor', trigger: 'user' },
  nodeId: 'work',
  name: 'run_command',
  arguments: '{"command":"npm test"}',
  ...over,
});

function sandbox(over: Partial<Parameters<typeof createSandboxDriver>[0]['backend']> = {}) {
  const backend = {
    exec: vi.fn(async () => ({ stdout: 'all good', stderr: '', exitCode: 0 })),
    readFile: vi.fn(async () => 'file contents'),
    writeFile: vi.fn(async () => undefined),
    listDir: vi.fn(async () => [{ name: 'src', type: 'dir' as const }, { name: 'a.ts', type: 'file' as const }]),
    deleteFile: vi.fn(async () => undefined),
    ...over,
  };
  return { backend, driver: createSandboxDriver({ sandboxId: 'sb-1', spec, backend }) };
}

const sourceFor = (driver: EnvironmentDriver | undefined): EnvironmentSource => ({ forRun: async () => driver });

const CATALOGUE: ToolContract[] = [
  { name: 'run_command', description: 'Run a shell command', binding: 'environment', requires: { terminal: true } },
  { name: 'read_file', description: 'Read a file', binding: 'environment', requires: { filesystem: true } },
  { name: 'write_file', description: 'Write a file', binding: 'environment', requires: { filesystem: true } },
  { name: 'list_dir', description: 'List a directory', binding: 'environment', requires: { filesystem: true } },
  { name: 'search_web', description: 'Search the web', binding: 'network' },
  { name: 'save_memory', description: 'Remember something', binding: 'platform' },
];

const EXECUTOR: AgentDefinition = {
  slug: 'executor',
  name: 'Executor',
  description: 'Does the work',
  version: '1',
  prompt: 'You do the work.',
  procedure: 'tool-rounds',
  guidance: '',
  returns: '',
  failures: [],
  tools: ['run_command', 'read_file', 'write_file', 'list_dir', 'save_memory'],
  budget: { maxRounds: 8 },
  environment: { terminal: true, filesystem: true },
  interface: { workspace: true },
};

const RESEARCH: AgentDefinition = {
  ...EXECUTOR,
  slug: 'research',
  tools: ['search_web'],
  environment: { egress: true },
  interface: {},
};

const registry = () => createAgentRegistry({
  agentStore: { list: async () => [EXECUTOR, RESEARCH] },
  toolCatalogue: { list: async () => CATALOGUE },
});

const runtime = (driver: EnvironmentDriver | undefined) =>
  createToolRuntime({ registry: registry(), environments: sourceFor(driver) });

describe('tool runtime', () => {
  it('runs a command through the environment driver', async () => {
    const { backend, driver } = sandbox();
    const outcome = await runtime(driver).run(args());

    expect(outcome).toMatchObject({ ok: true, digest: 'all good' });
    expect(backend.exec).toHaveBeenCalledWith(expect.objectContaining({ command: 'npm test' }));
  });

  it('reports a failing command as not ok without throwing', async () => {
    const { driver } = sandbox({ exec: vi.fn(async () => ({ stdout: '', stderr: 'no such file', exitCode: 127 })) });
    const outcome = await runtime(driver).run(args());

    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.digest).toContain('no such file');
  });

  it('reads, writes and lists through the driver', async () => {
    const { backend, driver } = sandbox();
    const tools = runtime(driver);

    expect(await tools.run(args({ name: 'read_file', arguments: '{"path":"a.ts"}' })))
      .toMatchObject({ ok: true, digest: 'file contents' });

    expect(await tools.run(args({ name: 'write_file', arguments: '{"path":"b.ts","content":"hello"}' })))
      .toMatchObject({ ok: true, digest: 'wrote 5 bytes to b.ts' });

    expect((await tools.run(args({ name: 'list_dir', arguments: '{"path":"."}' }))).digest)
      .toContain('d src');

    expect(backend.writeFile).toHaveBeenCalledWith(expect.objectContaining({ content: 'hello' }));
  });

  it('refuses a tool the agent was never granted', async () => {
    const { driver } = sandbox();
    const outcome = await runtime(driver).run(args({ name: 'search_web', arguments: '{"q":"x"}' }));

    expect(outcome.ok).toBe(false);
    expect(outcome.digest).toContain('not a tool this agent can use');
  });

  it('refuses an environment tool when the agent has no machine, explaining why', async () => {
    const outcome = await runtime(createNoneDriver()).run(args());

    expect(outcome.ok).toBe(false);
    expect(outcome.digest).toContain('cannot run commands');
  });

  it('still runs a network tool when the sandbox has no egress, because the server makes that call', async () => {
    const offline = createSandboxDriver({
      sandboxId: 'sb-2',
      spec: { ...spec, egress: false },
      backend: sandbox().backend,
    });

    const research = createToolRuntime({
      registry: registry(),
      environments: sourceFor(offline),
    });

    const outcome = await research.run(args({
      ticket: { runId: 'r', depth: 0, ownerId: 'user-1', agentSlug: 'research', trigger: 'user' },
      name: 'search_web',
      arguments: '{"q":"pods"}',
    }));

    expect(outcome.digest).not.toContain('cannot reach the network');
  });

  it('rejects malformed arguments instead of guessing', async () => {
    const { driver } = sandbox();
    const outcome = await runtime(driver).run(args({ arguments: '{not json' }));

    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.digest).toContain('not valid JSON');
  });

  it('turns a missing required argument into a readable refusal', async () => {
    const { driver } = sandbox();
    const outcome = await runtime(driver).run(args({ arguments: '{}' }));

    expect(outcome.ok).toBe(false);
    expect(outcome.digest).toContain('needs a "command"');
  });

  it('surfaces a path escape attempt as a refusal, not a crash', async () => {
    const { driver, backend } = sandbox();
    const scoped = createSandboxDriver({ sandboxId: 'sb-3', spec, scope: { path: 'work' }, backend });

    const outcome = await runtime(scoped).run(args({ name: 'read_file', arguments: '{"path":"../../etc/passwd"}' }));

    expect(outcome.ok).toBe(false);
    expect(outcome.digest).toContain('points outside');
    expect(backend.readFile).not.toHaveBeenCalled();
  });

  it('says so when a granted tool has no implementation here', async () => {
    const { driver } = sandbox();
    const outcome = await runtime(driver).run(args({ name: 'save_memory', arguments: '{"text":"x"}' }));

    expect(outcome.ok).toBe(false);
    expect(outcome.digest).toContain('no implementation here');
  });

  it('lets a caller supply handlers for platform tools', async () => {
    const { driver } = sandbox();
    const tools = createToolRuntime({
      registry: registry(),
      environments: sourceFor(driver),
      handlers: {
        save_memory: async () => ({ ok: true, digest: 'remembered', content: '' }),
      },
    });

    expect(await tools.run(args({ name: 'save_memory', arguments: '{"text":"x"}' })))
      .toMatchObject({ ok: true, digest: 'remembered' });
  });

  it('truncates a huge tool output rather than returning all of it', async () => {
    const { backend } = sandbox();
    backend.readFile = vi.fn(async () => 'x'.repeat(10_000));
    const driver = createSandboxDriver({ sandboxId: 'sb-4', spec, backend });

    const outcome = await createToolRuntime({
      registry: registry(),
      environments: sourceFor(driver),
      digestChars: 100,
    }).run(args({ name: 'read_file', arguments: '{"path":"big.txt"}' }));

    expect(outcome.digest.length).toBeLessThan(200);
    expect(outcome.digest).toContain('truncated');
    expect(outcome.content?.length).toBe(10_000);
  });

  it('refuses when the agent itself does not exist', async () => {
    const { driver } = sandbox();
    const outcome = await runtime(driver).run(args({
      ticket: { runId: 'r', depth: 0, ownerId: 'user-1', agentSlug: 'ghost', trigger: 'user' },
    }));

    expect(outcome.ok).toBe(false);
    expect(outcome.digest).toContain('no agent called "ghost"');
  });

  it('keeps the full content for the model even when the digest is clipped', async () => {
    const { driver } = sandbox();
    const outcome = await runtime(driver).run(args({ name: 'read_file', arguments: '{"path":"a.ts"}' }));

    expect(outcome.content).toBe('file contents');
  });
});
