import type { ValidationRecipe, ValidationCheckDefinition } from '../lib/tree-types.js';

export interface ValidationCheckResult {
  id: string;
  name: string;
  type: string;
  passed: boolean;
  message: string;
  durationMs: number;
  outputSnippet?: string | undefined;
}

export interface ValidationSummary {
  passed: boolean;
  type: 'document' | 'command' | 'runtime-service';
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  checks: ValidationCheckResult[];
  diagnosticReport: string;
}

export interface ValidationExecutionEnvironment {
  exec: (command: string, opts?: { timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean }>;
  readFile: (path: string) => Promise<string>;
  fetch?: typeof fetch | undefined;
}

export class UniversalValidatorService {
  /**
   * Infers a sensible validation recipe from a workspace when none was explicitly configured.
   * Enables existing, legacy, or custom projects to immediately benefit from the validator loop.
   */
  async inferRecipe(env: ValidationExecutionEnvironment): Promise<ValidationRecipe | undefined> {
    const checks: ValidationCheckDefinition[] = [];

    // 1. Node / TypeScript projects
    try {
      const pkgContent = await env.readFile('package.json');
      const pkg = JSON.parse(pkgContent);
      if (pkg.scripts?.test && !pkg.scripts.test.includes('no test specified')) {
        checks.push({
          id: 'test-suite',
          name: 'Test suite',
          description: 'Automated test suite defined in package.json',
          type: 'run-command',
          command: 'npm test',
        });
      }
      if (pkg.scripts?.build) {
        checks.push({
          id: 'build',
          name: 'Build check',
          description: 'Project build script defined in package.json',
          type: 'run-command',
          command: 'npm run build',
        });
      }
    } catch {
      // Not a node project
    }

    // 2. Python projects
    try {
      const pyproject = await env.readFile('pyproject.toml').catch(() => '');
      const reqs = await env.readFile('requirements.txt').catch(() => '');
      if (pyproject || reqs) {
        checks.push({
          id: 'python-test',
          name: 'Python test suite',
          description: 'Automated pytest / unittest execution',
          type: 'run-command',
          command: 'pytest || python -m unittest discover',
        });
      }
    } catch {
      // Not a python project
    }

    // 3. Go projects
    try {
      const gomod = await env.readFile('go.mod');
      if (gomod) {
        checks.push({
          id: 'go-test',
          name: 'Go test suite',
          description: 'go test execution',
          type: 'run-command',
          command: 'go test ./...',
        });
      }
    } catch {
      // Not a go project
    }

    // 4. Rust projects
    try {
      const cargo = await env.readFile('Cargo.toml');
      if (cargo) {
        checks.push({
          id: 'cargo-test',
          name: 'Cargo test suite',
          description: 'cargo test execution',
          type: 'run-command',
          command: 'cargo test',
        });
      }
    } catch {
      // Not a rust project
    }

    // 5. Documentation fallback
    if (!checks.length) {
      try {
        const readme = await env.readFile('README.md');
        if (readme) {
          checks.push({
            id: 'readme-check',
            name: 'Project documentation',
            description: 'README.md exists and is documented',
            type: 'file-exists',
            target: 'README.md',
          });
        }
      } catch {
        // No readme
      }
    }

    if (checks.length > 0) {
      return {
        type: 'command',
        checks,
      };
    }
    return undefined;
  }

  /**
   * Validates a workspace or branch against a validation recipe.
   *
   * Executes checks deterministically, capturing exact exit codes, stdout/stderr,
   * HTTP status codes, and JSON-RPC responses. Produces an LLM-actionable diagnostic
   * report for the worker/validator loop.
   */
  async validate(
    recipe: ValidationRecipe,
    env: ValidationExecutionEnvironment,
    focusCheckId?: string,
  ): Promise<ValidationSummary> {
    const checksToRun = focusCheckId
      ? recipe.checks.filter((c) => c.id === focusCheckId)
      : recipe.checks;

    const results: ValidationCheckResult[] = [];
    const fetchImpl = env.fetch ?? fetch;

    for (const check of checksToRun) {
      const startTime = Date.now();
      let result: ValidationCheckResult;

      try {
        result = await this.runSingleCheck(check, env, fetchImpl);
      } catch (err: any) {
        result = {
          id: check.id,
          name: check.name,
          type: check.type,
          passed: false,
          message: `Check threw unhandled error: ${err.message}`,
          durationMs: Date.now() - startTime,
        };
      }

      results.push(result);
    }

    const passedChecks = results.filter((r) => r.passed).length;
    const failedChecks = results.length - passedChecks;
    const allPassed = failedChecks === 0 && results.length > 0;

    const diagnosticReport = this.buildDiagnosticReport(recipe.type, results);

    return {
      passed: allPassed,
      type: recipe.type,
      totalChecks: results.length,
      passedChecks,
      failedChecks,
      checks: results,
      diagnosticReport,
    };
  }

  private async runSingleCheck(
    check: ValidationCheckDefinition,
    env: ValidationExecutionEnvironment,
    fetchImpl: typeof fetch,
  ): Promise<ValidationCheckResult> {
    const start = Date.now();

    switch (check.type) {
      case 'file-exists': {
        const target = check.target || '';
        if (!target) {
          return {
            id: check.id,
            name: check.name,
            type: check.type,
            passed: false,
            message: 'No target file specified for file-exists check',
            durationMs: Date.now() - start,
          };
        }

        try {
          const content = await env.readFile(target);
          const passed = content !== undefined && content.length > 0;
          return {
            id: check.id,
            name: check.name,
            type: check.type,
            passed,
            message: passed ? `File "${target}" exists (${content.length} bytes)` : `File "${target}" is empty`,
            durationMs: Date.now() - start,
          };
        } catch {
          // Fallback to test command in case readFile threw
          const res = await env.exec(`test -s "${target}"`);
          const passed = res.exitCode === 0;
          return {
            id: check.id,
            name: check.name,
            type: check.type,
            passed,
            message: passed ? `File "${target}" exists` : `File "${target}" does not exist or is empty`,
            durationMs: Date.now() - start,
          };
        }
      }

      case 'content-matches': {
        const target = check.target || '';
        const pattern = check.pattern || '';
        if (!target || !pattern) {
          return {
            id: check.id,
            name: check.name,
            type: check.type,
            passed: false,
            message: 'Target file and pattern are both required for content-matches check',
            durationMs: Date.now() - start,
          };
        }

        try {
          const content = await env.readFile(target);
          const re = new RegExp(pattern, 'm');
          const matched = re.test(content);
          return {
            id: check.id,
            name: check.name,
            type: check.type,
            passed: matched,
            message: matched
              ? `File "${target}" matches pattern /${pattern}/`
              : `File "${target}" does not contain expected pattern /${pattern}/`,
            durationMs: Date.now() - start,
          };
        } catch (err: any) {
          return {
            id: check.id,
            name: check.name,
            type: check.type,
            passed: false,
            message: `Could not read file "${target}": ${err.message}`,
            durationMs: Date.now() - start,
          };
        }
      }

      case 'run-command': {
        const command = check.command || '';
        if (!command) {
          return {
            id: check.id,
            name: check.name,
            type: check.type,
            passed: false,
            message: 'No command specified for run-command check',
            durationMs: Date.now() - start,
          };
        }

        const res = await env.exec(command, { timeoutMs: check.timeoutMs ?? 60_000 });
        const passed = res.exitCode === 0;
        const output = (res.stderr || res.stdout || '').trim();
        const snippet = output.length > 500 ? `${output.slice(0, 500)}...` : output;

        return {
          id: check.id,
          name: check.name,
          type: check.type,
          passed,
          message: passed
            ? `Command "${command}" succeeded with exit code 0`
            : `Command "${command}" failed with exit code ${res.exitCode}`,
          durationMs: Date.now() - start,
          outputSnippet: snippet,
        };
      }

      case 'http-probe': {
        const url = check.target || 'http://127.0.0.1:8080/health';
        const expected = check.expectedStatus ?? 200;

        try {
          const res = await fetchImpl(url, { signal: AbortSignal.timeout(check.timeoutMs ?? 10_000) });
          const passed = res.status === expected;
          const text = await res.text().catch(() => '');
          return {
            id: check.id,
            name: check.name,
            type: check.type,
            passed,
            message: passed
              ? `HTTP probe ${url} returned expected status ${expected}`
              : `HTTP probe ${url} returned status ${res.status} (expected ${expected})`,
            durationMs: Date.now() - start,
            outputSnippet: text.slice(0, 300),
          };
        } catch (err: any) {
          return {
            id: check.id,
            name: check.name,
            type: check.type,
            passed: false,
            message: `HTTP probe ${url} failed to connect: ${err.message}`,
            durationMs: Date.now() - start,
          };
        }
      }

      case 'mcp-probe': {
        const url = check.target || 'http://127.0.0.1:8080/mcp';
        try {
          // 1. Initialize probe
          const initRes = await fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'initialize',
              params: {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'universal-validator', version: '1.0' },
              },
            }),
            signal: AbortSignal.timeout(check.timeoutMs ?? 10_000),
          });

          if (!initRes.ok) {
            return {
              id: check.id,
              name: check.name,
              type: check.type,
              passed: false,
              message: `MCP probe ${url} failed initialize with HTTP ${initRes.status}`,
              durationMs: Date.now() - start,
            };
          }

          const initBody = (await initRes.json().catch(() => ({}))) as any;
          if (!initBody?.result?.protocolVersion) {
            return {
              id: check.id,
              name: check.name,
              type: check.type,
              passed: false,
              message: `MCP probe response missing protocolVersion: ${JSON.stringify(initBody).slice(0, 200)}`,
              durationMs: Date.now() - start,
            };
          }

          // 2. Tools list probe
          const listRes = await fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
            signal: AbortSignal.timeout(check.timeoutMs ?? 10_000),
          });

          const listBody = (await listRes.json().catch(() => ({}))) as any;
          const tools = listBody?.result?.tools ?? [];
          const toolNames = Array.isArray(tools) ? tools.map((t: any) => t.name).filter(Boolean) : [];

          return {
            id: check.id,
            name: check.name,
            type: check.type,
            passed: true,
            message: `MCP probe succeeded. Server answered initialize and exposed ${toolNames.length} tool(s): [${toolNames.join(', ')}]`,
            durationMs: Date.now() - start,
            outputSnippet: `Tools: ${toolNames.join(', ')}`,
          };
        } catch (err: any) {
          return {
            id: check.id,
            name: check.name,
            type: check.type,
            passed: false,
            message: `MCP probe ${url} connection failed: ${err.message}`,
            durationMs: Date.now() - start,
          };
        }
      }

      default:
        return {
          id: check.id,
          name: check.name,
          type: check.type,
          passed: false,
          message: `Unknown check type "${(check as any).type}"`,
          durationMs: Date.now() - start,
        };
    }
  }

  private buildDiagnosticReport(type: string, results: ValidationCheckResult[]): string {
    const lines: string[] = [
      `=== Validation Report (${type}) ===`,
      `Outcome: ${results.every((r) => r.passed) ? 'PASSED ✅' : 'FAILED ❌'}`,
      '',
    ];

    for (const r of results) {
      const icon = r.passed ? '✅' : '❌';
      lines.push(`${icon} [${r.id}] ${r.name} (${r.durationMs}ms)`);
      lines.push(`   ${r.message}`);
      if (r.outputSnippet && !r.passed) {
        lines.push(`   Diagnostic Output:`);
        lines.push(`   ${r.outputSnippet.replace(/\n/g, '\n   ')}`);
      }
    }

    return lines.join('\n');
  }
}
