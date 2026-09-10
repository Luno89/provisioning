import type { ValidationExecutionEnvironment } from '../services/UniversalValidatorService.js';
import {
  SANDBOX_FETCH_SCRIPT, SANDBOX_FETCH_SCRIPT_RELATIVE_PATH, SANDBOX_FETCH_COMMAND,
  sandboxFetchRequest, parseSandboxFetchOutput,
} from './sandbox-fetch.js';

/** Whatever runs a leaf's commands — the K8s sandbox today, a local machine as of this type's introduction. */
export interface LeafWorkspace {
  exec(leafId: string, command: string, timeoutMs?: number, positional?: string[]): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>;
  readFile(leafId: string, path: string): Promise<string>;
  writeFile(leafId: string, path: string, content: string): Promise<void>;
}

export async function buildValidatorEnv(
  workspaces: LeafWorkspace,
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
