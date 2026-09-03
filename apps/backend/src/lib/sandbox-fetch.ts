/** A `fetch`-shaped request run inside the sandbox pod via kubectl exec, since the pod's NetworkPolicy blocks direct ingress. */

/** Fixed script; request data arrives as argv, never interpolated into shell text. */
export const SANDBOX_FETCH_SCRIPT = `
const [url, method, headersJson, body] = process.argv.slice(2);
const headers = headersJson ? JSON.parse(headersJson) : {};
fetch(url, { method, headers, ...(body ? { body } : {}) })
  .then(async (res) => {
    const text = await res.text();
    process.stdout.write(JSON.stringify({ status: res.status, body: text }));
  })
  .catch((err) => {
    process.stdout.write(JSON.stringify({ error: String((err && err.message) || err) }));
    process.exitCode = 1;
  });
`;

/** Relative to WORKSPACE_MOUNT — writeFile() rejects anything outside it (e.g. /tmp). */
export const SANDBOX_FETCH_SCRIPT_RELATIVE_PATH = '.sandbox-fetch.mjs';
export const SANDBOX_FETCH_SCRIPT_PATH = `/work/${SANDBOX_FETCH_SCRIPT_RELATIVE_PATH}`;

/** The fixed shell command an exec call runs — the actual URL/method/headers/body arrive as `$1..$4`. */
export const SANDBOX_FETCH_COMMAND = `node ${SANDBOX_FETCH_SCRIPT_PATH} "$1" "$2" "$3" "$4"`;

export interface SandboxFetchRequest {
  url: string;
  method: string;
  headersJson: string;
  body: string;
}

/** Builds the positional-args request from a `fetch`-shaped call — never interpolated into a shell string. */
export function sandboxFetchRequest(url: string, init?: { method?: string; headers?: unknown; body?: unknown }): SandboxFetchRequest {
  return {
    url,
    method: init?.method ?? 'GET',
    headersJson: JSON.stringify(init?.headers ?? {}),
    body: typeof init?.body === 'string' ? init.body : '',
  };
}

export interface SandboxFetchResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}

/** Parses the probe script's stdout (a single JSON line) into a minimal `Response`-shaped result. */
export function parseSandboxFetchOutput(stdout: string): SandboxFetchResponse {
  const parsed = JSON.parse(stdout.trim() || '{}') as { status?: number; body?: string; error?: string };
  if (parsed.error) throw new Error(parsed.error);
  const status = parsed.status ?? 0;
  const body = parsed.body ?? '';
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}
