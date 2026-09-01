import { UniversalValidatorService } from '../services/UniversalValidatorService.js';
import { renderSearchOutcome, type WebTools } from './web-tools.js';
import type { ValidationRecipe } from './tree-types.js';

/**
 * Somewhere to run a command and read and write files.
 *
 * It lives here rather than in `agent-loop.ts` because the tools need it and the loop does not own
 * them any more -- they are registry entries like every other tool, and importing them back into
 * the loop would close a cycle.
 */
export interface SandboxDriver {
  exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

export type SaveMemory = (memory: {
  category: string;
  title: string;
  text: string;
  suggestedScope: 'project' | 'global';
}) => Promise<{ action: string }>;

/**
 * The tools that need a sandbox, dispatched by name.
 *
 * `web_search` and `fetch_web_page` are not among them: they need web access, not a sandbox, and
 * one handler each is enough for the whole platform.
 */
export async function runSandboxTool(
  sandbox: SandboxDriver,
  name: string,
  args: Record<string, unknown>,
  transcript: string[],
  web?: WebTools | undefined,
  saveMemory?: SaveMemory | undefined,
  validationRecipe?: ValidationRecipe | undefined,
  fetchImpl?: typeof fetch,
): Promise<string> {
  if (name === 'validate_progress') {
    transcript.push('validate_progress');
    const validator = new UniversalValidatorService();
    const env = {
      exec: async (cmd: string) => sandbox.exec(cmd),
      readFile: async (p: string) => sandbox.readFile(p),
      fetch: fetchImpl ?? fetch,
    };

    let activeRecipe = validationRecipe;
    if (!activeRecipe || !activeRecipe.checks?.length) {
      activeRecipe = await validator.inferRecipe(env);
    }

    if (!activeRecipe || !activeRecipe.checks?.length) {
      return JSON.stringify({
        passed: true,
        message: 'No specific validation recipe configured for this leaf. Verify manually using test commands or artifact inspection.',
      });
    }

    const focusCheck = args.focusCheck ? String(args.focusCheck) : undefined;
    const summary = await validator.validate(activeRecipe, env, focusCheck);
    return JSON.stringify({
      passed: summary.passed,
      type: summary.type,
      totalChecks: summary.totalChecks,
      passedChecks: summary.passedChecks,
      failedChecks: summary.failedChecks,
      diagnosticReport: summary.diagnosticReport,
      checks: summary.checks,
    });
  }

  if (name === 'run_command') {
    const command = String(args.command ?? '');
    if (!command.trim()) return JSON.stringify({ error: 'command is required' });
    transcript.push(command);
    const r = await sandbox.exec(command);
    return JSON.stringify({
      exitCode: r.exitCode,
      ...(r.timedOut ? { timedOut: true, note: 'Command was killed for taking too long.' } : {}),
      stdout: r.stdout,
      stderr: r.stderr,
    });
  }

  if (name === 'write_file') {
    let path = String(args.path ?? '');
    if (!path) return JSON.stringify({ error: 'path is required' });
    if (path.startsWith('/work/')) path = path.slice(6);
    else if (path.startsWith('work/')) path = path.slice(5);
    const content = typeof args.content === 'object' && args.content !== null
      ? JSON.stringify(args.content, null, 2)
      : String(args.content ?? '');
    await sandbox.writeFile(path, content);
    transcript.push(`write ${path}`);
    return JSON.stringify({ written: path, bytes: content.length });
  }

  if (name === 'read_file') {
    let path = String(args.path ?? '');
    if (!path) return JSON.stringify({ error: 'path is required' });
    if (path.startsWith('/work/')) path = path.slice(6);
    else if (path.startsWith('work/')) path = path.slice(5);
    transcript.push(`read ${path}`);
    return JSON.stringify({ path, content: await sandbox.readFile(path) });
  }

  if (name === 'save_harness_memory') {
    const title = String(args.title ?? '').trim();
    const text = String(args.text ?? '').trim();
    const category = String(args.category ?? 'lessons_learned');
    if (!title || !text) return JSON.stringify({ error: 'title and text are required' });
    transcript.push(`memory: ${title}`);

    if (!saveMemory) {
      return JSON.stringify({
        saved: false,
        error: 'Memory cannot be saved in this run — nothing is listening. Say it in your finish summary instead.',
      });
    }

    const suggestedScope = args.suggestedScope === 'global' ? 'global' : 'project';
    let action = 'ADD';
    try {
      ({ action } = await saveMemory({ category, title, text, suggestedScope }));
    } catch (err: any) {
      return JSON.stringify({ saved: false, error: `Could not save that: ${String(err?.message ?? err).slice(0, 200)}` });
    }

    const noted = action === 'NOOP'
      ? 'Not stored — the memory bank already holds this. Nothing more to do.'
      : 'Stored. It will be available to future runs on this project.';

    return JSON.stringify({ saved: action !== 'NOOP', action, category, title, suggestedScope, note: noted });
  }

  if (name === 'inspect_git_diff') {
    transcript.push('inspect_git_diff');
    await sandbox.exec('git init 2>/dev/null || true');
    await sandbox.exec('git config user.email koala@test 2>/dev/null || true');
    await sandbox.exec('git config user.name Koala 2>/dev/null || true');
    await sandbox.exec('git add -N . 2>/dev/null || true');
    const r = await sandbox.exec('git diff HEAD || git diff');
    return JSON.stringify({
      exitCode: r.exitCode,
      diff: r.stdout || r.stderr || 'No git diff changes found in repository.',
    });
  }

  if (name === 'test_http_endpoint') {
    const url = String(args.url ?? 'http://localhost:8080');
    const method = String(args.method ?? 'GET');
    transcript.push(`http ${method} ${url}`);
    const r = await sandbox.exec(`curl -s -i -X ${method} "${url}"`);
    return JSON.stringify({
      exitCode: r.exitCode,
      response: r.stdout || r.stderr,
    });
  }

  if (name === 'run_linter_audit') {
    const path = String(args.path ?? '.');
    transcript.push(`linter ${path}`);
    const r = await sandbox.exec(`npx eslint "${path}" || true`);
    return JSON.stringify({
      exitCode: r.exitCode,
      output: r.stdout || r.stderr || 'Linter audit complete.',
    });
  }

  if (name === 'query_in_memory_db') {
    const query = typeof args.query === 'object' && args.query !== null
      ? JSON.stringify(args.query)
      : String(args.query ?? '');
    transcript.push(`db_query ${query}`);
    const r = await sandbox.exec(`node -e 'try { const d=require("./db.json"); console.log(JSON.stringify(d)); } catch(e) { console.log("[]"); }'`);
    return JSON.stringify({
      exitCode: r.exitCode,
      result: r.stdout,
    });
  }

  if (name === 'run_tests') {
    const command = String(args.command ?? 'npm test');
    transcript.push(`run_tests: ${command}`);
    const r = await sandbox.exec(command);
    return JSON.stringify({
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
    });
  }

  if (name === 'web_search' || name === 'fetch_web_page') {
    if (!web) {
      return JSON.stringify({ error: 'No web tools are available to this run. Do not try curl or wget — this sandbox has no network access.' });
    }
    if (name === 'web_search') {
      const query = String(args.query ?? '').trim();
      if (!query) return JSON.stringify({ error: 'query parameter is required' });
      transcript.push(`web_search: ${query}`);
      try {
        const outcome = await web.search(query);

        return JSON.stringify(renderSearchOutcome(query, outcome));
      } catch (err: any) {
        return JSON.stringify({
          query,
          unavailable: true,
          error: `Search failed: ${err?.message || err}`,
          note: 'This says nothing about whether results exist. Rephrasing will not help.',
        });
      }
    }
    const url = String(args.url ?? '').trim();
    if (!url) return JSON.stringify({ error: 'url parameter is required' });
    transcript.push(`fetch_web_page: ${url}`);
    try {
      return JSON.stringify({ url, content: await web.fetchPage(url) });
    } catch (err: any) {
      return JSON.stringify({ url, content: `Failed to fetch page: ${err?.message || err}` });
    }
  }

  return JSON.stringify({ error: `Unknown tool ${name}` });
}
