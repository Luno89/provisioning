import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { NODE_SERVICE_FILES, MCP_SERVER_FILES, LIBRARY_FILES } from './project-templates.js';
import { renderStarterFiles } from './tree-types.js';
import { TREE_TYPE_SEEDS } from './tree-type-seeds.js';
import { McpClient } from './mcp-client.js';

let child: ChildProcess | undefined;
afterEach(() => { child?.kill(); child = undefined; });

const startScaffold = async (): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-template-'));
  for (const file of renderStarterFiles(MCP_SERVER_FILES, { projectName: 'test-server', registryHost: '' })) {
    const full = join(dir, file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.content);
  }
  const port = 8000 + Math.floor(Math.random() * 900);
  child = spawn('node', [join(dir, 'src/server.js')], {
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore',
  });
  const url = `http://127.0.0.1:${port}/mcp`;
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`);
      return url;
    } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('the scaffold never started listening');
};

describe('a project started from the mcp-server template', () => {
  it('is introspectable by the registry\'s own client', async () => {
    const client = new McpClient(await startScaffold());
    const session = await client.initialize();
    expect(session.protocolVersion).toBeTruthy();
    expect(session.sessionId).toBeTruthy();

    const tools = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools[0]!.inputSchema).toBeTruthy();
  }, 30_000);

  it('runs a tool and returns text a caller can read', async () => {
    const client = new McpClient(await startScaffold());
    await client.initialize();
    const out = await client.callTool('echo', { message: 'hello' });
    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/hello/);
  }, 30_000);

  it('reports an unknown tool without falling over', async () => {
    const client = new McpClient(await startScaffold());
    await client.initialize();
    const out = await client.callTool('does-not-exist', {});
    expect(out.isError).toBe(true);
  }, 30_000);

  it('answers /health, which is what the platform probes', async () => {
    const url = await startScaffold();
    const res = await fetch(url.replace('/mcp', '/health'));
    expect(res.status).toBe(200);
  }, 30_000);
});

describe('the scaffold itself', () => {
  it('has everything the pipeline needs to build and deploy it', () => {
    const paths = renderStarterFiles(MCP_SERVER_FILES, { projectName: 'x', registryHost: '' }).map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining([
      'Dockerfile', 'package.json', 'src/server.js', 'test/server.test.js', 'README.md',
    ]));
  });

  it('depends on nothing', () => {
    const pkg = renderStarterFiles(MCP_SERVER_FILES, { projectName: 'x', registryHost: '' }).find((f) => f.path === 'package.json')!;
    const parsed = JSON.parse(pkg.content);
    expect(parsed.dependencies ?? {}).toEqual({});
  });

  it('is carried by the mcp-server type record', () => {
    const seed = TREE_TYPE_SEEDS.find((t) => t.id === 'mcp-server')!;
    expect(seed.files.map((f) => f.path)).toContain('src/server.js');
  });
});
