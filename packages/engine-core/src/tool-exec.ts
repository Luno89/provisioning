import { effectiveTools, type ToolContract } from './tools.js';
import { ScopeError } from './scope.js';
import { NO_CAPABILITIES, type EnvironmentDriver } from './environment.js';

export interface ToolOutcome {
  ok: boolean;
  digest: string;
  content?: string | undefined;
}

export interface ToolCallerContext {
  ownerId?: string | undefined;
  projectId?: string | undefined;
  runId?: string | undefined;
  agentSlug?: string | undefined;
}

export interface ToolHandlerContext {
  name: string;
  parsed: Record<string, unknown>;
  driver: EnvironmentDriver | undefined;
  caller: ToolCallerContext;
}

export type ToolHandler = (ctx: ToolHandlerContext) => Promise<ToolOutcome>;

export const DEFAULT_DIGEST_CHARS = 2_000;

const clip = (text: string, max: number): string =>
  (text.length <= max ? text : `${text.slice(0, max)}\n[…truncated]`);

const stringArg = (parsed: Record<string, unknown>, key: string): string => {
  const value = parsed[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`this call needs a "${key}"`);
  }
  return value;
};

function requireDriver(ctx: ToolHandlerContext): EnvironmentDriver {
  if (!ctx.driver) throw new Error('this agent has no machine, so it cannot do that');
  return ctx.driver;
}

export const environmentHandlers: Record<string, ToolHandler> = {
  async run_command(ctx) {
    const driver = requireDriver(ctx);
    const result = await driver.exec({
      command: stringArg(ctx.parsed, 'command'),
      ...(typeof ctx.parsed.cwd === 'string' ? { cwd: ctx.parsed.cwd } : {}),
    });

    const body = [result.stdout, result.stderr].filter(Boolean).join('\n');
    return {
      ok: result.exitCode === 0,
      digest: body || `exited ${result.exitCode}`,
      content: body,
    };
  },

  async read_file(ctx) {
    const driver = requireDriver(ctx);
    const content = await driver.readFile(stringArg(ctx.parsed, 'path'));
    return { ok: true, digest: content, content };
  },

  async write_file(ctx) {
    const driver = requireDriver(ctx);
    const path = stringArg(ctx.parsed, 'path');
    const content = typeof ctx.parsed.content === 'string' ? ctx.parsed.content : '';
    await driver.writeFile(path, content);
    return { ok: true, digest: `wrote ${content.length} bytes to ${path}`, content: '' };
  },

  async list_dir(ctx) {
    const driver = requireDriver(ctx);
    const entries = await driver.listDir(typeof ctx.parsed.path === 'string' ? ctx.parsed.path : '.');
    const rendered = entries.map((entry) => `${entry.type === 'dir' ? 'd' : '-'} ${entry.name}`).join('\n');
    return { ok: true, digest: rendered, content: rendered };
  },

  async delete_file(ctx) {
    const driver = requireDriver(ctx);
    const path = stringArg(ctx.parsed, 'path');
    await driver.deleteFile(path);
    return { ok: true, digest: `deleted ${path}`, content: '' };
  },
};

export interface ExecuteToolInput {
  name: string;
  arguments: string;
  granted: string[];
  catalogue: readonly ToolContract[];
  driver?: EnvironmentDriver | undefined;
  handlers?: Record<string, ToolHandler> | undefined;
  digestChars?: number | undefined;
  caller?: ToolCallerContext | undefined;
}

export const refuse = (why: string): ToolOutcome => ({ ok: false, digest: why, content: why });

export async function executeTool(input: ExecuteToolInput): Promise<ToolOutcome> {
  const handlers = { ...environmentHandlers, ...(input.handlers ?? {}) };
  const digestChars = input.digestChars ?? DEFAULT_DIGEST_CHARS;
  const capabilities = input.driver?.handle().capabilities ?? NO_CAPABILITIES;

  const { tools, withheld } = effectiveTools({
    granted: input.granted,
    catalogue: [...input.catalogue],
    capabilities,
  });

  if (!tools.some((tool) => tool.name === input.name)) {
    return refuse(
      withheld.find((entry) => entry.name === input.name)?.why
      ?? `"${input.name}" is not a tool this agent can use`,
    );
  }

  const handler = handlers[input.name];
  if (!handler) return refuse(`"${input.name}" has no implementation here`);

  let parsed: Record<string, unknown> = {};
  if (input.arguments.trim()) {
    try {
      parsed = JSON.parse(input.arguments) as Record<string, unknown>;
    } catch {
      return refuse(`the arguments for "${input.name}" were not valid JSON`);
    }
  }

  try {
    const outcome = await handler({
      name: input.name,
      parsed,
      driver: input.driver,
      caller: input.caller ?? {},
    });
    return {
      ok: outcome.ok,
      digest: clip(outcome.digest, digestChars),
      ...(outcome.content === undefined ? {} : { content: outcome.content }),
    };
  } catch (err) {
    return refuse(
      err instanceof ScopeError
        ? err.message
        : `that call failed: ${(err as Error).message}`,
    );
  }
}
