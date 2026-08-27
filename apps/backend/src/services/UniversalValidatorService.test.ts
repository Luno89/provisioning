import { describe, it, expect } from 'vitest';
import { UniversalValidatorService } from './UniversalValidatorService.js';
import type { ValidationRecipe } from '../lib/tree-types.js';

describe('UniversalValidatorService', () => {
  const service = new UniversalValidatorService();

  it('validates document recipes (file-exists and content-matches)', async () => {
    const recipe: ValidationRecipe = {
      type: 'document',
      checks: [
        { id: 'file-check', name: 'paper.md exists', type: 'file-exists', target: 'paper.md' },
        { id: 'content-check', name: 'Contains Abstract', type: 'content-matches', target: 'paper.md', pattern: '## Abstract' },
      ],
    };

    const files: Record<string, string> = {
      'paper.md': '# Title\n\n## Abstract\nThis is the abstract.',
    };

    const env = {
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      readFile: async (p: string) => files[p] ?? '',
    };

    const summary = await service.validate(recipe, env);
    expect(summary.passed).toBe(true);
    expect(summary.totalChecks).toBe(2);
    expect(summary.passedChecks).toBe(2);
    expect(summary.failedChecks).toBe(0);
    expect(summary.diagnosticReport).toContain('PASSED ✅');
  });

  it('fails document recipe when expected pattern is missing', async () => {
    const recipe: ValidationRecipe = {
      type: 'document',
      checks: [
        { id: 'content-check', name: 'Contains Findings', type: 'content-matches', target: 'paper.md', pattern: '## Findings' },
      ],
    };

    const env = {
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      readFile: async () => '# Title\n\nNo findings here.',
    };

    const summary = await service.validate(recipe, env);
    expect(summary.passed).toBe(false);
    expect(summary.failedChecks).toBe(1);
    expect(summary.diagnosticReport).toContain('FAILED ❌');
  });

  it('validates command recipes (run-command)', async () => {
    const recipe: ValidationRecipe = {
      type: 'command',
      checks: [
        { id: 'test-check', name: 'Run tests', type: 'run-command', command: 'npm test' },
      ],
    };

    const env = {
      exec: async (cmd: string) => ({
        exitCode: cmd === 'npm test' ? 0 : 1,
        stdout: 'All 5 tests passed',
        stderr: '',
      }),
      readFile: async () => '',
    };

    const summary = await service.validate(recipe, env);
    expect(summary.passed).toBe(true);
    expect(summary.checks[0]?.message).toContain('succeeded with exit code 0');
  });

  it('validates runtime service recipes (http-probe and mcp-probe)', async () => {
    const recipe: ValidationRecipe = {
      type: 'runtime-service',
      checks: [
        { id: 'health', name: 'Health check', type: 'http-probe', target: 'http://127.0.0.1:8080/health', expectedStatus: 200 },
        { id: 'mcp', name: 'MCP initialize', type: 'mcp-probe', target: 'http://127.0.0.1:8080/mcp' },
      ],
    };

    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/health')) {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }
      if (urlStr.endsWith('/mcp')) {
        const body = JSON.parse(String(init?.body || '{}'));
        if (body.method === 'initialize') {
          return new Response(JSON.stringify({ result: { protocolVersion: '2024-11-05' } }), { status: 200 });
        }
        if (body.method === 'tools/list') {
          return new Response(JSON.stringify({ result: { tools: [{ name: 'echo' }, { name: 'get_status' }] } }), { status: 200 });
        }
      }
      return new Response('Not Found', { status: 404 });
    };

    const env = {
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      readFile: async () => '',
      fetch: mockFetch as typeof fetch,
    };

    const summary = await service.validate(recipe, env);
    expect(summary.passed).toBe(true);
    expect(summary.checks.find((c) => c.id === 'mcp')?.message).toContain('exposed 2 tool(s): [echo, get_status]');
  });

  it('infers recipe for Node projects with test scripts', async () => {
    const env = {
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      readFile: async (p: string) => {
        if (p === 'package.json') {
          return JSON.stringify({ scripts: { test: 'vitest run', build: 'tsc' } });
        }
        throw new Error('File not found');
      },
    };

    const recipe = await service.inferRecipe(env);
    expect(recipe).toBeDefined();
    expect(recipe?.checks).toHaveLength(2);
    expect(recipe?.checks.map((c) => c.command)).toEqual(['npm test', 'npm run build']);
  });

  it('infers recipe for Python projects with pyproject.toml', async () => {
    const env = {
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      readFile: async (p: string) => {
        if (p === 'pyproject.toml') return '[tool.poetry]\nname = "demo"';
        throw new Error('File not found');
      },
    };

    const recipe = await service.inferRecipe(env);
    expect(recipe).toBeDefined();
    expect(recipe?.checks[0]?.command).toContain('pytest');
  });

  it('infers documentation check when only README.md exists', async () => {
    const env = {
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      readFile: async (p: string) => {
        if (p === 'README.md') return '# My Project';
        throw new Error('File not found');
      },
    };

    const recipe = await service.inferRecipe(env);
    expect(recipe).toBeDefined();
    expect(recipe?.checks[0]?.type).toBe('file-exists');
    expect(recipe?.checks[0]?.target).toBe('README.md');
  });
});
