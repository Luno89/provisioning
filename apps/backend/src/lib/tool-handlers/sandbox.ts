import { runSandboxTool } from '../sandbox-tool-runner.js';
import { json, type ToolEntry, type ToolNeed, type ToolRuntime } from '../tool-runtime.js';

/**
 * The sandbox tools, as registry entries.
 *
 * They all need the same thing -- somewhere to run -- and saying so is the whole point: granting
 * `run_command` to a chat pack now answers "run_command needs a sandbox to run in", instead of
 * "No tool named run_command", which was true of no runtime and helped nobody.
 */
const SANDBOX_TOOLS = [
  'run_command', 'read_file', 'write_file', 'run_tests', 'inspect_git_diff',
  'test_http_endpoint', 'run_linter_audit', 'query_in_memory_db', 'save_harness_memory',
  'validate_progress',
] as const;

const needs: readonly ToolNeed[] = ['sandbox'];

export const SANDBOX_ENTRIES: Record<string, ToolEntry> = {
  ...Object.fromEntries(SANDBOX_TOOLS.map((name) => [name, {
    needs,
    run: async (rt: ToolRuntime, args: Record<string, unknown>) => ({
      content: await runSandboxTool(
        rt.sandbox!,
        name,
        args,
        rt.transcript ?? [],
        undefined,
        rt.saveMemory,
        rt.validationRecipe,
        rt.fetchImpl,
      ),
    }),
  } satisfies ToolEntry])),

  /**
   * `finish` ends the agent loop, so the loop itself intercepts it before dispatch and this never
   * runs there. It exists so the name resolves everywhere else, and says what it is for.
   */
  finish: {
    needs,
    run: async () => json({
      error: 'finish ends a sandbox run, and this is not one. Just say what you have concluded.',
    }),
  },
};
