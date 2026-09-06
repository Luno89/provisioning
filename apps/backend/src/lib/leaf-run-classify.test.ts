import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDB } from './memory-db.js';
import { classifyLeafRun } from './leaf-run-classify.js';
import type { TreeTypeSpec } from './tree-types.js';
import type { Tree } from './trees.js';
import type { Branch } from './leaves.js';

let db: MemoryDB;

const resolveBaseUrl = async () => ({
  provider: { id: 'dep-1', name: 'Tabby', model: 'Qwen3-32B', kind: 'tabbyapi' } as any,
  baseUrl: 'http://model',
  source: 'sole' as const,
});

const mcpServerType = {
  id: 'mcp-server', ownerId: undefined, label: 'MCP server', summary: 's',
  language: 'node', produces: 'service', doneMeans: 'server answers initialize',
  files: [],
  validationRecipe: {
    type: 'runtime-service',
    checks: [
      { id: 'pkg-json', name: 'package.json exists', type: 'file-exists', target: 'package.json' },
      { id: 'mcp-probe', name: 'MCP initialize probe', type: 'mcp-probe', target: 'http://127.0.0.1:8080/mcp' },
    ],
  },
} as unknown as TreeTypeSpec;

const tree = (over: Partial<Tree> = {}): Tree => ({
  id: 't1', ownerId: 'u1', name: 'Test tree', type: 'mcp-server', goal: 'g', brief: 'b',
  context: '', conversationId: 'c1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
} as Tree);

const branch = (over: Partial<Branch> = {}): Branch => ({
  id: 'b1', ownerId: 'u1', title: 'Branch', messages: [], createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z', ...over,
} as Branch);

beforeEach(async () => {
  db = new MemoryDB();
  await db.init();
});

describe('classifyLeafRun', () => {
  it('falls back to a documentless, repo-less classification when nothing is configured', async () => {
    await db.saveBranch(branch({ id: 'b-none' }));

    const out = await classifyLeafRun({ db, resolveBaseUrl }, {
      ownerId: 'u1', branchId: 'b-none',
    });

    expect(out.treeType).toBeUndefined();
    expect(out.wantsRepo).toBe(false);
    expect(out.isDocumentLeaf).toBe(true);
    expect(out.producesCode).toBe(true);
  });

  it('resolves a service tree type to a repo-backed, non-document classification with its recipe', async () => {
    await db.saveTreeType(mcpServerType);
    await db.saveTree(tree({ id: 't-mcp', type: 'mcp-server' }));
    await db.saveBranch(branch({ id: 'b-mcp', treeId: 't-mcp' }));

    const out = await classifyLeafRun({ db, resolveBaseUrl }, {
      ownerId: 'u1', branchId: 'b-mcp',
    });

    expect(out.treeType?.id).toBe('mcp-server');
    expect(out.wantsRepo).toBe(true);
    expect(out.isDocumentLeaf).toBe(false);
    expect(out.producesCode).toBe(true);
  });

  it('strips runtime-probe checks from the classified leafRecipe — they belong at acceptance, not here', async () => {
    await db.saveTreeType(mcpServerType);
    await db.saveTree(tree({ id: 't-mcp2', type: 'mcp-server' }));
    await db.saveBranch(branch({ id: 'b-mcp2', treeId: 't-mcp2' }));

    const out = await classifyLeafRun({ db, resolveBaseUrl }, {
      ownerId: 'u1', branchId: 'b-mcp2',
    });

    const types = out.leafRecipe?.checks.map((c) => c.type) ?? [];
    expect(types).not.toContain('mcp-probe');
    expect(types).toContain('file-exists');
  });

  it('lets an explicit leaf.validationContract override the tree type recipe', async () => {
    await db.saveBranch(branch({ id: 'b-explicit' }));

    const contract = {
      type: 'command' as const,
      checks: [{ id: 'custom', name: 'Custom check', type: 'run-command' as const, command: 'echo ok' }],
    };
    const out = await classifyLeafRun({ db, resolveBaseUrl }, {
      ownerId: 'u1', branchId: 'b-explicit', validationContract: contract,
    });

    expect(out.leafRecipe).toEqual(contract);
  });

  it('resolves the model provider via the injected resolveBaseUrl', async () => {
    await db.saveBranch(branch({ id: 'b-model' }));

    const out = await classifyLeafRun({ db, resolveBaseUrl }, {
      ownerId: 'u1', branchId: 'b-model',
    });

    expect(out.baseUrl).toBe('http://model');
    expect(out.provider.model).toBe('Qwen3-32B');
  });
});
