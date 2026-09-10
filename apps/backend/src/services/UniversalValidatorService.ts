import {
  isContainerNode,
  flattenRecipeLeaves,
  substituteRecipeNodesItem,
  type ValidationRecipe,
  type ValidationCheckDefinition,
  type RecipeNode,
  type RecipeGroup,
  type RecipeLoop,
} from '../lib/tree-types.js';

export interface ValidationCheckResult {
  id: string;
  name: string;
  type: string;
  passed: boolean;
  message: string;
  durationMs: number;
  outputSnippet?: string | undefined;
  /** True when optional:true and this check failed — it's reported but doesn't fail the recipe. */
  wasOptionalFailure?: boolean | undefined;
  /** True when this check's runIf target didn't pass, so it never ran. */
  skipped?: boolean | undefined;
  /** How many attempts this check took (>1 means an earlier attempt failed and it was retried). */
  attempts?: number | undefined;
}

export interface ValidationSummary {
  passed: boolean;
  type: 'document' | 'command' | 'runtime-service';
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  checks: ValidationCheckResult[];
  diagnosticReport: string;
  /** True when the recipe's own timeoutMs was hit before every check ran. */
  timedOut?: boolean | undefined;
}

export interface ValidationExecutionEnvironment {
  exec: (command: string, opts?: { timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean }>;
  readFile: (path: string) => Promise<string>;
  fetch?: typeof fetch | undefined;
}

interface RunContext {
  env: ValidationExecutionEnvironment;
  fetchImpl: typeof fetch;
  passedById: Map<string, boolean>;
  results: ValidationCheckResult[];
  deadline: number | undefined;
  timedOut: boolean;
}

export class UniversalValidatorService {
  async inferRecipe(env: ValidationExecutionEnvironment): Promise<ValidationRecipe | undefined> {
    const checks: ValidationCheckDefinition[] = [];

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
    } catch { /* ignored */ }

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
    } catch { /* ignored */ }

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
    } catch { /* ignored */ }

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
    } catch { /* ignored */ }

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
      } catch { /* ignored */ }
    }

    if (checks.length > 0) {
      return {
        type: 'command',
        checks,
      };
    }
    return undefined;
  }

  async validate(
    recipe: ValidationRecipe,
    env: ValidationExecutionEnvironment,
    focusCheckId?: string,
  ): Promise<ValidationSummary> {
    const nodesToRun: RecipeNode[] = focusCheckId
      ? flattenRecipeLeaves(recipe.checks).filter((c) => c.id === focusCheckId)
      : recipe.checks;

    const ctx: RunContext = {
      env,
      fetchImpl: env.fetch ?? fetch,
      passedById: new Map<string, boolean>(),
      results: [],
      deadline: recipe.timeoutMs !== undefined ? Date.now() + recipe.timeoutMs : undefined,
      timedOut: false,
    };

    await this.runNodes(nodesToRun, ctx, false, '');

    const results = ctx.results;
    const countable = results.filter((r) => this.isCountable(r));
    const passedChecks = results.filter((r) => r.passed).length;
    const failedChecks = countable.filter((r) => !r.passed).length;
    const allPassed = failedChecks === 0 && countable.length > 0 && !ctx.timedOut;

    const diagnosticReport = this.buildDiagnosticReport(recipe.type, results, ctx.timedOut);

    return {
      passed: allPassed,
      type: recipe.type,
      totalChecks: results.length,
      passedChecks,
      failedChecks,
      checks: results,
      diagnosticReport,
      ...(ctx.timedOut ? { timedOut: true } : {}),
    };
  }

  private isCountable(r: ValidationCheckResult): boolean {
    return !r.skipped && !r.wasOptionalFailure;
  }

  private async runNodes(nodes: readonly RecipeNode[], ctx: RunContext, inheritedOptional: boolean, labelSuffix: string): Promise<void> {
    for (const node of nodes) {
      if (ctx.timedOut) return;
      if (ctx.deadline !== undefined && Date.now() >= ctx.deadline) {
        ctx.timedOut = true;
        return;
      }
      if (isContainerNode(node)) {
        await this.runContainer(node, ctx, inheritedOptional, labelSuffix);
      } else {
        await this.runLeaf(node, ctx, inheritedOptional, labelSuffix);
      }
    }
  }

  private async runLeaf(check: ValidationCheckDefinition, ctx: RunContext, inheritedOptional: boolean, labelSuffix: string): Promise<void> {
    if (check.runIf !== undefined && ctx.passedById.get(check.runIf) !== true) {
      ctx.results.push({
        id: check.id,
        name: check.name + labelSuffix,
        type: check.type,
        passed: false,
        skipped: true,
        message: `Skipped — runIf "${check.runIf}" did not pass.`,
        durationMs: 0,
      });
      return;
    }

    const startTime = Date.now();
    const attemptBudget = 1 + Math.max(0, check.retries ?? 0);
    let result: ValidationCheckResult | undefined;

    for (let attempt = 1; attempt <= attemptBudget; attempt++) {
      try {
        result = await this.runSingleCheck(check, ctx.env, ctx.fetchImpl);
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
      result.attempts = attempt;
      if (result.passed || attempt === attemptBudget) break;
      if (check.retryDelayMs) await new Promise((r) => setTimeout(r, check.retryDelayMs));
    }

    if (result && (inheritedOptional || check.optional) && !result.passed) {
      result = { ...result, wasOptionalFailure: true };
    }
    if (labelSuffix) result = { ...result!, name: result!.name + labelSuffix };

    ctx.results.push(result!);
    ctx.passedById.set(check.id, result!.passed);
  }

  private async runContainer(node: RecipeGroup | RecipeLoop, ctx: RunContext, inheritedOptional: boolean, labelSuffix: string): Promise<void> {
    if (node.runIf !== undefined && ctx.passedById.get(node.runIf) !== true) {
      this.skipSubtree(node.children, `Skipped — runIf "${node.runIf}" did not pass.`, ctx, labelSuffix);
      return;
    }

    const childOptional = inheritedOptional || Boolean(node.optional);
    const passed = node.containerType === 'group'
      ? await this.runScoped(node.children, ctx, childOptional, labelSuffix)
      : await this.runLoop(node, ctx, childOptional, labelSuffix);
    ctx.passedById.set(node.id, passed);
  }

  private skipSubtree(nodes: readonly RecipeNode[], reason: string, ctx: RunContext, labelSuffix: string): void {
    for (const node of nodes) {
      if (isContainerNode(node)) {
        this.skipSubtree(node.children, reason, ctx, labelSuffix);
      } else {
        ctx.results.push({
          id: node.id,
          name: node.name + labelSuffix,
          type: node.type,
          passed: false,
          skipped: true,
          message: reason,
          durationMs: 0,
        });
      }
    }
  }

  private async runScoped(nodes: readonly RecipeNode[], ctx: RunContext, inheritedOptional: boolean, labelSuffix: string): Promise<boolean> {
    const start = ctx.results.length;
    await this.runNodes(nodes, ctx, inheritedOptional, labelSuffix);
    const slice = ctx.results.slice(start);
    const countable = slice.filter((r) => this.isCountable(r));
    return countable.length > 0 && countable.every((r) => r.passed);
  }

  private async runLoop(node: RecipeLoop, ctx: RunContext, inheritedOptional: boolean, labelSuffix: string): Promise<boolean> {
    const atCapacity = () => ctx.timedOut || (ctx.deadline !== undefined && Date.now() >= ctx.deadline);

    if (node.loopType === 'count') {
      const n = Math.max(1, node.maxIterations ?? 1);
      let lastPassed = false;
      for (let i = 1; i <= n && !atCapacity(); i++) {
        lastPassed = await this.runScoped(node.children, ctx, inheritedOptional, `${labelSuffix} (iteration ${i}/${n})`);
      }
      return lastPassed;
    }

    if (node.loopType === 'until') {
      const cap = Math.max(1, node.maxIterations ?? 10);
      const loopDeadline = node.timeoutMs !== undefined ? Date.now() + node.timeoutMs : undefined;
      let lastPassed = false;
      for (let i = 1; i <= cap && !atCapacity() && (loopDeadline === undefined || Date.now() < loopDeadline); i++) {
        const start = ctx.results.length;
        lastPassed = await this.runScoped(node.children, ctx, inheritedOptional, `${labelSuffix} (attempt ${i}/${cap})`);
        if (lastPassed) break;
        const isFinalAttempt = i === cap || atCapacity() || (loopDeadline !== undefined && Date.now() >= loopDeadline);
        if (!isFinalAttempt) {
          for (let idx = start; idx < ctx.results.length; idx++) {
            const r = ctx.results[idx];
            if (r && !r.skipped && !r.passed) ctx.results[idx] = { ...r, wasOptionalFailure: true };
          }
        }
      }
      return lastPassed;
    }

    if (!node.itemsCommand) {
      ctx.results.push({
        id: node.id,
        name: node.name + labelSuffix,
        type: 'loop',
        passed: false,
        message: 'forEach loop has no itemsCommand configured.',
        durationMs: 0,
      });
      return false;
    }

    const listing = await ctx.env.exec(node.itemsCommand, { timeoutMs: node.timeoutMs ?? 60_000 });
    const items = listing.stdout.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 100);
    if (!items.length) {
      ctx.results.push({
        id: node.id,
        name: node.name + labelSuffix,
        type: 'loop',
        passed: false,
        message: `forEach itemsCommand produced no items: "${node.itemsCommand}"`,
        durationMs: 0,
      });
      return false;
    }

    const loopDeadline = node.timeoutMs !== undefined ? Date.now() + node.timeoutMs : undefined;
    let allPassed = true;
    for (const item of items) {
      if (atCapacity() || (loopDeadline !== undefined && Date.now() >= loopDeadline)) break;
      const substituted = substituteRecipeNodesItem([...node.children], item);
      const passed = await this.runScoped(substituted, ctx, inheritedOptional, `${labelSuffix} [${item}]`);
      allPassed = allPassed && passed;
    }
    return allPassed;
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

      case 'git-tracked': {
        const target = check.target || '';
        if (!target) {
          return {
            id: check.id,
            name: check.name,
            type: check.type,
            passed: false,
            message: 'No target file specified for git-tracked check',
            durationMs: Date.now() - start,
          };
        }

        const res = await env.exec(`git ls-files --error-unmatch -- "${target}"`, { timeoutMs: check.timeoutMs ?? 15_000 });
        const passed = res.exitCode === 0;
        return {
          id: check.id,
          name: check.name,
          type: check.type,
          passed,
          message: passed
            ? `"${target}" is committed to git`
            : `"${target}" is not tracked by git — it exists on disk but was never committed`,
          durationMs: Date.now() - start,
          outputSnippet: passed ? undefined : (res.stderr || res.stdout || '').trim().slice(0, 300),
        };
      }

      case 'k8s-probe': {
        const kind = check.kind ?? 'pod';
        const namespace = check.namespace || '';
        const target = check.target || '';
        if (!namespace || !target) {
          return {
            id: check.id,
            name: check.name,
            type: check.type,
            passed: false,
            message: 'k8s-probe needs both namespace and target (the resource name).',
            durationMs: Date.now() - start,
          };
        }

        const jsonPath = kind === 'pod'
          ? "{.status.phase}"
          : kind === 'deployment'
            ? "{.status.readyReplicas}/{.spec.replicas}"
            : "{.metadata.name}";
        const res = await env.exec(
          `kubectl get ${kind} "${target}" -n "${namespace}" -o jsonpath="${jsonPath}"`,
          { timeoutMs: check.timeoutMs ?? 15_000 },
        );
        const out = res.stdout.trim();
        const passed = res.exitCode === 0 && (
          kind === 'pod' ? out === 'Running'
          : kind === 'deployment' ? (() => {
              const [ready, total] = out.split('/');
              return Boolean(ready) && ready === total;
            })()
          : out.length > 0
        );
        return {
          id: check.id,
          name: check.name,
          type: check.type,
          passed,
          message: passed
            ? `${kind} "${target}" in "${namespace}" is ready (${out})`
            : `${kind} "${target}" in "${namespace}" is not ready${out ? ` (${out})` : ''}`,
          durationMs: Date.now() - start,
          outputSnippet: passed ? undefined : (res.stderr || out).slice(0, 300),
        };
      }

      case 'wait-for': {
        if (!check.waitForType) {
          return {
            id: check.id,
            name: check.name,
            type: check.type,
            passed: false,
            message: 'wait-for needs waitForType to name the check it polls.',
            durationMs: Date.now() - start,
          };
        }

        const wrapped: ValidationCheckDefinition = { ...check, type: check.waitForType };
        const deadline = Date.now() + (check.timeoutMs ?? 30_000);
        const pollIntervalMs = check.pollIntervalMs ?? 2_000;
        let last: ValidationCheckResult;
        for (;;) {
          last = await this.runSingleCheck(wrapped, env, fetchImpl);
          if (last.passed || Date.now() >= deadline) break;
          await new Promise((r) => setTimeout(r, pollIntervalMs));
        }
        return {
          id: check.id,
          name: check.name,
          type: check.type,
          passed: last.passed,
          message: last.passed
            ? `Condition (${check.waitForType}) met before timeout: ${last.message}`
            : `Timed out waiting for ${check.waitForType}: ${last.message}`,
          durationMs: Date.now() - start,
          outputSnippet: last.outputSnippet,
        };
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

  private buildDiagnosticReport(type: string, results: ValidationCheckResult[], timedOut = false): string {
    const blocking = results.filter((r) => !r.skipped && !r.wasOptionalFailure);
    const outcome = timedOut ? 'TIMED OUT ⏱️' : blocking.every((r) => r.passed) && blocking.length > 0 ? 'PASSED ✅' : 'FAILED ❌';
    const lines: string[] = [
      `=== Validation Report (${type}) ===`,
      `Outcome: ${outcome}`,
      '',
    ];

    for (const r of results) {
      const icon = r.skipped ? '⏭️' : r.wasOptionalFailure ? '⚠️' : r.passed ? '✅' : '❌';
      const attemptsNote = r.attempts && r.attempts > 1 ? `, ${r.attempts} attempts` : '';
      lines.push(`${icon} [${r.id}] ${r.name} (${r.durationMs}ms${attemptsNote})`);
      lines.push(`   ${r.message}`);
      if (r.outputSnippet && !r.passed) {
        lines.push(`   Diagnostic Output:`);
        lines.push(`   ${r.outputSnippet.replace(/\n/g, '\n   ')}`);
      }
    }
    if (timedOut) lines.push('', '(Recipe timeoutMs was reached — remaining checks were not run.)');

    return lines.join('\n');
  }
}
