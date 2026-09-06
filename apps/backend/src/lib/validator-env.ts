import type { WorkspaceService } from '../services/WorkspaceService.js';
import type { ValidationExecutionEnvironment } from '../services/UniversalValidatorService.js';
import {
  SANDBOX_FETCH_SCRIPT, SANDBOX_FETCH_SCRIPT_RELATIVE_PATH, SANDBOX_FETCH_COMMAND,
  sandboxFetchRequest, parseSandboxFetchOutput,
} from './sandbox-fetch.js';

export async function buildValidatorEnv(
  workspaces: WorkspaceService,
  workspaceId: string,
  opts: { cwd?: string | undefined } = {},
): Promise<ValidationExecutionEnvironment> {
  await workspaces.writeFile(workspaceId, SANDBOX_FETCH_SCRIPT_RELATIVE_PATH, SANDBOX_FETCH_SCRIPT);
  const cd = opts.cwd ? `cd ${opts.cwd} && ` : '';
  return {
    exec: async (cmd: string, execOpts) => {
      const res = await workspaces.exec(workspaceId, `${cd}${cmd}`, execOpts?.timeoutMs ?? 180_000);
      return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
    },
    readFile: async (p: string) => workspaces.readFile(workspaceId, `/work/repo/${p}`)
      .catch(() => workspaces.readFile(workspaceId, `/work/${p}`))
      .catch(() => workspaces.readFile(workspaceId, p)),
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const req = sandboxFetchRequest(String(input instanceof Request ? input.url : input), init);
      const res = await workspaces.exec(
        workspaceId, SANDBOX_FETCH_COMMAND, 20_000,
        ['sh', req.url, req.method, req.headersJson, req.body],
      );
      if (res.exitCode !== 0 && !res.stdout.trim()) {
        throw new Error(res.stderr || `sandbox fetch exited ${res.exitCode} with no output`);
      }
      return parseSandboxFetchOutput(res.stdout) as unknown as Response;
    },
  };
}
