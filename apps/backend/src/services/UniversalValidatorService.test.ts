import { describe, it, expect } from 'vitest';
import { UniversalValidatorService } from './UniversalValidatorService.js';
import { flattenRecipeLeaves, type ValidationRecipe } from '../lib/tree-types.js';

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
    expect(flattenRecipeLeaves(recipe?.checks ?? []).map((c) => c.command)).toEqual(['npm test', 'npm run build']);
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
    expect(flattenRecipeLeaves(recipe?.checks ?? [])[0]?.command).toContain('pytest');
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
    const [leaf] = flattenRecipeLeaves(recipe?.checks ?? []);
    expect(leaf?.type).toBe('file-exists');
    expect(leaf?.target).toBe('README.md');
  });

  it('validates git-tracked (a file present on disk but never committed fails)', async () => {
    const recipe: ValidationRecipe = {
      type: 'command',
      checks: [{ id: 'tracked', name: 'Script is committed', type: 'git-tracked', target: 'acceptance-check.sh' }],
    };

    const untracked = await service.validate(recipe, {
      exec: async () => ({ exitCode: 1, stdout: '', stderr: 'error: pathspec did not match' }),
      readFile: async () => '',
    });
    expect(untracked.passed).toBe(false);
    expect(untracked.checks[0]?.message).toContain('not tracked');

    const tracked = await service.validate(recipe, {
      exec: async () => ({ exitCode: 0, stdout: 'acceptance-check.sh\n', stderr: '' }),
      readFile: async () => '',
    });
    expect(tracked.passed).toBe(true);
  });

  it('validates k8s-probe for a pod, a ready deployment, and a not-ready deployment', async () => {
    const podRecipe: ValidationRecipe = {
      type: 'runtime-service',
      checks: [{ id: 'pod', name: 'Pod running', type: 'k8s-probe', kind: 'pod', target: 'my-app-0', namespace: 'default' }],
    };
    const running = await service.validate(podRecipe, {
      exec: async () => ({ exitCode: 0, stdout: 'Running', stderr: '' }),
      readFile: async () => '',
    });
    expect(running.passed).toBe(true);

    const deployRecipe: ValidationRecipe = {
      type: 'runtime-service',
      checks: [{ id: 'dep', name: 'Deployment ready', type: 'k8s-probe', kind: 'deployment', target: 'my-app', namespace: 'default' }],
    };
    const ready = await service.validate(deployRecipe, {
      exec: async () => ({ exitCode: 0, stdout: '3/3', stderr: '' }),
      readFile: async () => '',
    });
    expect(ready.passed).toBe(true);

    const notReady = await service.validate(deployRecipe, {
      exec: async () => ({ exitCode: 0, stdout: '1/3', stderr: '' }),
      readFile: async () => '',
    });
    expect(notReady.passed).toBe(false);
  });

  it('validates wait-for by polling the wrapped check until it passes', async () => {
    let attempts = 0;
    const recipe: ValidationRecipe = {
      type: 'runtime-service',
      checks: [{
        id: 'wait', name: 'Wait for health', type: 'wait-for', waitForType: 'http-probe',
        target: 'http://x/health', timeoutMs: 1000, pollIntervalMs: 1,
      }],
    };

    const mockFetch = async () => {
      attempts++;
      return new Response('', { status: attempts < 3 ? 503 : 200 });
    };

    const summary = await service.validate(recipe, {
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      readFile: async () => '',
      fetch: mockFetch as typeof fetch,
    });
    expect(summary.passed).toBe(true);
    expect(attempts).toBeGreaterThanOrEqual(3);
  });

  it('wait-for times out and fails when the condition never passes', async () => {
    const recipe: ValidationRecipe = {
      type: 'runtime-service',
      checks: [{
        id: 'wait', name: 'Wait for health', type: 'wait-for', waitForType: 'http-probe',
        target: 'http://x/health', timeoutMs: 10, pollIntervalMs: 1,
      }],
    };

    const summary = await service.validate(recipe, {
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      readFile: async () => '',
      fetch: (async () => new Response('', { status: 503 })) as typeof fetch,
    });
    expect(summary.passed).toBe(false);
    expect(summary.checks[0]?.message).toContain('Timed out');
  });

  it('runIf skips a check whose dependency did not pass, without counting it as a failure', async () => {
    const recipe: ValidationRecipe = {
      type: 'command',
      checks: [
        { id: 'build', name: 'Build', type: 'run-command', command: 'build' },
        { id: 'smoke', name: 'Smoke test', type: 'run-command', command: 'smoke', runIf: 'build' },
      ],
    };

    const summary = await service.validate(recipe, {
      exec: async (cmd: string) => ({ exitCode: cmd === 'build' ? 1 : 0, stdout: '', stderr: '' }),
      readFile: async () => '',
    });
    expect(summary.passed).toBe(false); // build itself failed
    expect(summary.checks.find((c) => c.id === 'smoke')?.skipped).toBe(true);
    expect(summary.checks.find((c) => c.id === 'smoke')?.passed).toBe(false);
  });

  it('runIf runs the dependent check once its dependency passes', async () => {
    const recipe: ValidationRecipe = {
      type: 'command',
      checks: [
        { id: 'build', name: 'Build', type: 'run-command', command: 'build' },
        { id: 'smoke', name: 'Smoke test', type: 'run-command', command: 'smoke', runIf: 'build' },
      ],
    };

    const summary = await service.validate(recipe, {
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      readFile: async () => '',
    });
    expect(summary.passed).toBe(true);
    expect(summary.checks.find((c) => c.id === 'smoke')?.skipped).toBeFalsy();
  });

  it('optional:true lets the recipe pass despite that one check failing, but still reports it', async () => {
    const recipe: ValidationRecipe = {
      type: 'command',
      checks: [
        { id: 'required', name: 'Required', type: 'run-command', command: 'ok' },
        { id: 'nice-to-have', name: 'Nice to have', type: 'run-command', command: 'flaky', optional: true },
      ],
    };

    const summary = await service.validate(recipe, {
      exec: async (cmd: string) => ({ exitCode: cmd === 'ok' ? 0 : 1, stdout: '', stderr: '' }),
      readFile: async () => '',
    });
    expect(summary.passed).toBe(true);
    const optionalResult = summary.checks.find((c) => c.id === 'nice-to-have');
    expect(optionalResult?.passed).toBe(false);
    expect(optionalResult?.wasOptionalFailure).toBe(true);
    expect(summary.diagnosticReport).toContain('⚠️');
  });

  it('retries a failing check up to N times before giving up', async () => {
    let calls = 0;
    const recipe: ValidationRecipe = {
      type: 'command',
      checks: [{ id: 'flaky', name: 'Flaky', type: 'run-command', command: 'flaky', retries: 2 }],
    };

    const summary = await service.validate(recipe, {
      exec: async () => { calls++; return { exitCode: calls < 3 ? 1 : 0, stdout: '', stderr: '' }; },
      readFile: async () => '',
    });
    expect(summary.passed).toBe(true);
    expect(calls).toBe(3); // 1 initial + 2 retries
    expect(summary.checks[0]?.attempts).toBe(3);
  });

  it('a check exhausting its retries still fails, and stops retrying once it passes', async () => {
    let calls = 0;
    const recipe: ValidationRecipe = {
      type: 'command',
      checks: [{ id: 'always-fails', name: 'Always fails', type: 'run-command', command: 'nope', retries: 1 }],
    };

    const summary = await service.validate(recipe, {
      exec: async () => { calls++; return { exitCode: 1, stdout: '', stderr: '' }; },
      readFile: async () => '',
    });
    expect(summary.passed).toBe(false);
    expect(calls).toBe(2); // 1 initial + 1 retry, then gives up
  });

  it('enforces recipe.timeoutMs, stopping remaining checks and reporting timedOut', async () => {
    const recipe: ValidationRecipe = {
      type: 'command',
      timeoutMs: 5,
      checks: [
        { id: 'slow', name: 'Slow', type: 'run-command', command: 'slow' },
        { id: 'never-runs', name: 'Never runs', type: 'run-command', command: 'noop' },
      ],
    };

    const summary = await service.validate(recipe, {
      exec: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      readFile: async () => '',
    });
    expect(summary.timedOut).toBe(true);
    expect(summary.passed).toBe(false);
    expect(summary.checks.some((c) => c.id === 'never-runs')).toBe(false);
    expect(summary.diagnosticReport).toContain('TIMED OUT');
  });
});

describe('UniversalValidatorService — groups and loops', () => {
  const service = new UniversalValidatorService();

  it("a group's optional gates its children as a unit", async () => {
    const recipe: ValidationRecipe = {
      type: 'command',
      checks: [
        { id: 'required', name: 'Required', type: 'run-command', command: 'ok' },
        {
          id: 'g1', name: 'Optional group', containerType: 'group', optional: true,
          children: [{ id: 'flaky', name: 'Flaky', type: 'run-command', command: 'flaky' }],
        },
      ],
    };

    const summary = await service.validate(recipe, {
      exec: async (cmd: string) => ({ exitCode: cmd === 'ok' ? 0 : 1, stdout: '', stderr: '' }),
      readFile: async () => '',
    });
    expect(summary.passed).toBe(true);
    const flaky = summary.checks.find((c) => c.id === 'flaky');
    expect(flaky?.passed).toBe(false);
    expect(flaky?.wasOptionalFailure).toBe(true);
  });

  it("a group's runIf skips every child when the target did not pass", async () => {
    const recipe: ValidationRecipe = {
      type: 'command',
      checks: [
        { id: 'build', name: 'Build', type: 'run-command', command: 'build' },
        {
          id: 'g1', name: 'Group', containerType: 'group', runIf: 'build',
          children: [
            { id: 'a', name: 'A', type: 'run-command', command: 'a' },
            { id: 'b', name: 'B', type: 'run-command', command: 'b' },
          ],
        },
      ],
    };

    const summary = await service.validate(recipe, {
      exec: async (cmd: string) => ({ exitCode: cmd === 'build' ? 1 : 0, stdout: '', stderr: '' }),
      readFile: async () => '',
    });
    expect(summary.checks.find((c) => c.id === 'a')?.skipped).toBe(true);
    expect(summary.checks.find((c) => c.id === 'b')?.skipped).toBe(true);
  });

  it('a count loop runs its children exactly maxIterations times', async () => {
    let calls = 0;
    const recipe: ValidationRecipe = {
      type: 'command',
      checks: [{
        id: 'l1', name: 'Loop', containerType: 'loop', loopType: 'count', maxIterations: 3,
        children: [{ id: 'step', name: 'Step', type: 'run-command', command: 'step' }],
      }],
    };

    const summary = await service.validate(recipe, {
      exec: async () => { calls++; return { exitCode: 0, stdout: '', stderr: '' }; },
      readFile: async () => '',
    });
    expect(calls).toBe(3);
    expect(summary.checks.filter((c) => c.id === 'step')).toHaveLength(3);
    expect(summary.passed).toBe(true);
  });

  it('an until loop stops as soon as one full iteration passes', async () => {
    let calls = 0;
    const recipe: ValidationRecipe = {
      type: 'command',
      checks: [{
        id: 'l1', name: 'Loop', containerType: 'loop', loopType: 'until', maxIterations: 5,
        children: [{ id: 'step', name: 'Step', type: 'run-command', command: 'step' }],
      }],
    };

    const summary = await service.validate(recipe, {
      exec: async () => { calls++; return { exitCode: calls < 3 ? 1 : 0, stdout: '', stderr: '' }; },
      readFile: async () => '',
    });
    expect(calls).toBe(3);
    expect(summary.checks.filter((c) => c.id === 'step')).toHaveLength(3);
    expect(summary.passed).toBe(true);
  });

  it('an until loop respects its maxIterations cap when it never passes', async () => {
    let calls = 0;
    const recipe: ValidationRecipe = {
      type: 'command',
      checks: [{
        id: 'l1', name: 'Loop', containerType: 'loop', loopType: 'until', maxIterations: 3,
        children: [{ id: 'step', name: 'Step', type: 'run-command', command: 'step' }],
      }],
    };

    const summary = await service.validate(recipe, {
      exec: async () => { calls++; return { exitCode: 1, stdout: '', stderr: '' }; },
      readFile: async () => '',
    });
    expect(calls).toBe(3);
    expect(summary.passed).toBe(false);
  });

  it('a forEach loop runs once per itemsCommand line and substitutes {{item}}', async () => {
    const seenCommands: string[] = [];
    const recipe: ValidationRecipe = {
      type: 'command',
      checks: [{
        id: 'l1', name: 'Loop', containerType: 'loop', loopType: 'forEach', itemsCommand: 'list-items',
        children: [{ id: 'step', name: 'Step', type: 'run-command', command: 'echo {{item}}' }],
      }],
    };

    const summary = await service.validate(recipe, {
      exec: async (cmd: string) => {
        if (cmd === 'list-items') return { exitCode: 0, stdout: 'a\nb\nc', stderr: '' };
        seenCommands.push(cmd);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      readFile: async () => '',
    });
    expect(seenCommands).toEqual(['echo a', 'echo b', 'echo c']);
    expect(summary.checks.filter((c) => c.id === 'step')).toHaveLength(3);
    expect(summary.passed).toBe(true);
  });

  it('a forEach loop with no items from itemsCommand fails and reports why', async () => {
    const recipe: ValidationRecipe = {
      type: 'command',
      checks: [{
        id: 'l1', name: 'Loop', containerType: 'loop', loopType: 'forEach', itemsCommand: 'list-items',
        children: [{ id: 'step', name: 'Step', type: 'run-command', command: 'echo {{item}}' }],
      }],
    };

    const summary = await service.validate(recipe, {
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      readFile: async () => '',
    });
    expect(summary.passed).toBe(false);
    expect(summary.checks.find((c) => c.id === 'l1')?.message).toContain('no items');
  });

  it("a runIf after a loop sees the loop's most recent iteration for a step inside it", async () => {
    let calls = 0;
    const recipe: ValidationRecipe = {
      type: 'command',
      checks: [
        {
          id: 'l1', name: 'Loop', containerType: 'loop', loopType: 'count', maxIterations: 2,
          children: [{ id: 'step', name: 'Step', type: 'run-command', command: 'step' }],
        },
        { id: 'after', name: 'After', type: 'run-command', command: 'after', runIf: 'step' },
      ],
    };

    const summary = await service.validate(recipe, {
      exec: async (cmd: string) => {
        if (cmd === 'step') { calls++; return { exitCode: calls === 2 ? 0 : 1, stdout: '', stderr: '' }; }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      readFile: async () => '',
    });
    expect(summary.checks.find((c) => c.id === 'after')?.skipped).toBeFalsy();
  });
});
