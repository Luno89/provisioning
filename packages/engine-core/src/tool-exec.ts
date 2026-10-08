import { effectiveTools, type ToolContract, type ToolEffect } from './tools.js';
import { renderCommand } from './command-tool.js';
import { ScopeError } from './scope.js';
import { NO_CAPABILITIES, type EnvironmentDriver } from './environment.js';

export type ToolArtifact =
  | { kind: 'file'; path: string }
  | { kind: 'link'; url: string; title?: string | undefined };

export interface ToolOutcome {
  ok: boolean;
  digest: string;
  content?: string | undefined;
  artifacts?: ToolArtifact[] | undefined;
  /** The call ran, but the peer answered no (a site that blocks fetches replying 401/403). The tool worked as designed, so failure monitors do not count it. */
  declined?: boolean;
}

export interface ToolCallerContext {
  ownerId?: string | undefined;
  projectId?: string | undefined;
  runId?: string | undefined;
  agentSlug?: string | undefined;
  conversationId?: string | undefined;
  inConversationWorkspace?: boolean | undefined;
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

export function commandHandlerFor(tool: ToolContract | undefined): ToolHandler | undefined {
  const template = tool?.command;
  if (!template) return undefined;

  return async (ctx) => {
    const driver = requireDriver(ctx);
    const rendered = renderCommand(template, ctx.parsed);
    if ('refused' in rendered) return { ok: false, digest: rendered.refused, content: rendered.refused };

    const result = await driver.exec({ command: rendered.command });
    const body = [result.stdout, result.stderr].filter(Boolean).join('\n');

    return {
      ok: result.exitCode === 0,
      digest: body || `exited ${result.exitCode}`,
      content: body,
    };
  };
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
    const given = ctx.parsed.content;
    if (given === undefined || given === null || (typeof given !== 'string' && typeof given !== 'object')) {
      const said = 'nothing was written — content has to be the text to write into the file';
      return { ok: false, digest: said, content: said };
    }
    const structured = typeof given !== 'string';
    const content = structured ? `${JSON.stringify(given, null, 2)}\n` : given;
    await driver.writeFile(path, content);
    const said = `wrote ${content.length} bytes to ${path}${structured ? ' — content arrived as JSON data, so it was written out as JSON' : ''}`;
    return { ok: true, digest: said, content: said, artifacts: [{ kind: 'file', path }] };
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
    return { ok: true, digest: `deleted ${path}`, content: `deleted ${path}` };
  },
};

export interface ExecuteToolInput {
  name: string;
  arguments: string;
  granted: string[];
  catalogue: readonly ToolContract[];
  ceiling?: ToolEffect | undefined;
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
    ...(input.ceiling ? { ceiling: input.ceiling } : {}),
  });

  if (!tools.some((tool) => tool.name === input.name)) {
    return refuse(
      withheld.find((entry) => entry.name === input.name)?.why
      ?? `"${input.name}" is not a tool this agent can use`,
    );
  }

  const handler = handlers[input.name] ?? commandHandlerFor(tools.find((tool) => tool.name === input.name));
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
      ...(outcome.declined ? { declined: outcome.declined } : {}),
      ...(outcome.artifacts?.length ? { artifacts: outcome.artifacts } : {}),
    };
  } catch (err) {
    return refuse(
      err instanceof ScopeError
        ? err.message
        : `that call failed: ${(err as Error).message}`,
    );
  }
}
