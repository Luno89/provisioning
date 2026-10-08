export interface ScriptWhen {
  offered?: string[] | undefined;
  called?: string[] | undefined;
  notCalled?: string[] | undefined;
  asked?: string | undefined;
  system?: string | undefined;
  said?: string | undefined;
}

export interface ScriptCall {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface ScriptReply {
  say?: string | undefined;
  call?: ScriptCall[] | undefined;
  paceMs?: number | undefined;
}

export interface ScriptRule {
  when: ScriptWhen;
  reply: ScriptReply;
}

export interface CheckScript {
  rules: ScriptRule[];
  contextTokens?: number | undefined;
}

export interface ScriptMessage {
  role: string;
  content?: string | null | undefined;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[] | undefined;
  tool_call_id?: string | undefined;
}

export interface ScriptRequest {
  messages: ScriptMessage[];
  tools: string[];
}

export interface ScriptContext {
  tasks: readonly string[];
  leaves: readonly string[];
  world: Readonly<Record<string, unknown>>;
}

export interface ScriptAnswer {
  say?: string | undefined;
  calls: { name: string; arguments: Record<string, unknown> }[];
  paceMs?: number | undefined;
}

const LOOKUP = /\{\{\s*([a-zA-Z]+)(?:\.([a-zA-Z0-9_.-]+))?\s*\}\}/g;
export const LOOKUPS = ['asked', 'said', 'directory', 'mentioned', 'result', 'world'] as const;
const WHEN_KEYS = ['offered', 'called', 'notCalled', 'asked', 'system', 'said'];
const DIRECTORY = /Write what you produce under \/work\/([^\s]+\/)/;

const textOf = (message: ScriptMessage): string =>
  `${message.content ?? ''}${(message.tool_calls ?? []).map((call) => ` ${call.function.name} ${call.function.arguments}`).join('')}`;

export const thisTurn = (request: ScriptRequest): ScriptMessage[] =>
  request.messages.slice(Math.max(0, request.messages.map((message) => message.role).lastIndexOf('user')));

const calledIn = (messages: readonly ScriptMessage[]): string[] => messages.flatMap((message) => (message.tool_calls ?? []).map((call) => call.function.name));

const regex = (pattern: string): RegExp => new RegExp(pattern, 's');

function lookupsIn(value: unknown, found: string[] = []): string[] {
  if (typeof value === 'string') for (const match of value.matchAll(LOOKUP)) found.push(match[1]!);
  else if (Array.isArray(value)) for (const entry of value) lookupsIn(entry, found);
  else if (value && typeof value === 'object') for (const entry of Object.values(value)) lookupsIn(entry, found);
  return found;
}

export function scriptProblems(script: unknown, knownTools: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const rules = (script as CheckScript | undefined)?.rules;
  if (!Array.isArray(rules) || rules.length === 0) return ['a script needs at least one rule'];
  const contextTokens = (script as CheckScript).contextTokens;
  if (contextTokens !== undefined && (!Number.isInteger(contextTokens) || contextTokens < 1024)) problems.push('contextTokens has to be a whole number of at least 1024');
  rules.forEach((rule, index) => {
    const where = `rule ${index + 1}`;
    if (!rule || typeof rule !== 'object' || !rule.when || !rule.reply) {
      problems.push(`${where} needs a when and a reply`);
      return;
    }
    for (const key of Object.keys(rule.when)) if (!WHEN_KEYS.includes(key)) problems.push(`${where}: "${key}" is not something a rule can match on`);
    for (const key of ['asked', 'system', 'said'] as const) {
      const pattern = rule.when[key];
      if (pattern === undefined) continue;
      try {
        regex(pattern);
      } catch (err) {
        problems.push(`${where}: ${key} is not a regular expression: ${(err as Error).message}`);
      }
    }
    for (const key of ['offered', 'called', 'notCalled'] as const) {
      for (const tool of rule.when[key] ?? []) if (!knownTools.has(tool)) problems.push(`${where}: ${tool} is not a tool`);
    }
    if (!rule.reply.say && !rule.reply.call?.length) problems.push(`${where} has to say something or call a tool`);
    for (const call of rule.reply.call ?? []) if (!knownTools.has(call.tool)) problems.push(`${where} calls ${call.tool}, which is not a tool`);
    if (rule.reply.paceMs !== undefined && !(Number.isInteger(rule.reply.paceMs) && rule.reply.paceMs >= 0)) problems.push(`${where}: paceMs has to be a whole number of milliseconds`);
    for (const name of lookupsIn(rule.reply)) {
      if (!(LOOKUPS as readonly string[]).includes(name)) problems.push(`${where} looks up {{${name}}}, which is not one of ${LOOKUPS.join(', ')}`);
    }
  });
  return problems;
}

interface Matched {
  asked: RegExpMatchArray | null;
  said: RegExpMatchArray | null;
}

function matches(rule: ScriptRule, request: ScriptRequest): Matched | undefined {
  const { when } = rule;
  if ((when.offered ?? []).some((tool) => !request.tools.includes(tool))) return undefined;
  const called = calledIn(thisTurn(request));
  if ((when.called ?? []).some((tool) => !called.includes(tool))) return undefined;
  if ((when.notCalled ?? []).some((tool) => called.includes(tool))) return undefined;
  const asked = request.messages.filter((message) => message.role === 'user').at(-1)?.content ?? '';
  const system = request.messages.filter((message) => message.role === 'system').map(textOf).join('\n');
  const said = request.messages.map(textOf).join('\n');
  const askedMatch = when.asked === undefined ? null : asked.match(regex(when.asked));
  if (when.asked !== undefined && !askedMatch) return undefined;
  if (when.system !== undefined && !regex(when.system).test(system)) return undefined;
  const saidMatch = when.said === undefined ? null : said.match(regex(when.said));
  if (when.said !== undefined && !saidMatch) return undefined;
  return { asked: askedMatch, said: saidMatch };
}

function lastResult(request: ScriptRequest, tool: string): string {
  const calls = request.messages.flatMap((message) => message.tool_calls ?? []).filter((call) => call.function.name === tool);
  const last = calls.at(-1);
  if (!last) return '';
  return request.messages.find((message) => message.role === 'tool' && message.tool_call_id === last.id)?.content ?? '';
}

function worldValue(world: Readonly<Record<string, unknown>>, path: string): unknown {
  return path.split('.').reduce<unknown>((at, key) => (at && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined), world);
}

export class ScriptLookupError extends Error {}

function render(value: unknown, request: ScriptRequest, context: ScriptContext, matched: Matched): unknown {
  if (Array.isArray(value)) return value.map((entry) => render(entry, request, context, matched));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, render(entry, request, context, matched)]));
  if (typeof value !== 'string') return value;
  const all = request.messages.map(textOf).join('\n');
  return value.replace(LOOKUP, (_whole, name: string, path: string | undefined) => {
    switch (name) {
      case 'asked':
      case 'said': {
        const group = (name === 'asked' ? matched.asked : matched.said)?.[Number(path ?? 0)];
        if (group === undefined) throw new ScriptLookupError(`{{${name}.${path ?? 0}}} has nothing: the rule's ${name} pattern did not capture it`);
        return group;
      }
      case 'directory': {
        const directory = all.match(DIRECTORY)?.[1];
        if (!directory) throw new ScriptLookupError('{{directory}} has nothing: the run was not told a directory of its own');
        return directory;
      }
      case 'mentioned': {
        const pool = path === 'leaf' ? context.leaves : path === 'task' ? context.tasks : undefined;
        if (!pool) throw new ScriptLookupError(`{{mentioned.${path ?? ''}}} is not a lookup: use mentioned.task or mentioned.leaf`);
        const id = pool.find((candidate) => all.includes(candidate));
        if (!id) throw new ScriptLookupError(`{{mentioned.${path}}} has nothing: no ${path} of this check is named in what the model was sent`);
        return id;
      }
      case 'result':
        return lastResult(request, path ?? '');
      case 'world': {
        const found = worldValue(context.world, path ?? '');
        if (found === undefined) throw new ScriptLookupError(`{{world.${path ?? ''}}} has nothing: no earlier stage recorded it`);
        return typeof found === 'string' ? found : JSON.stringify(found);
      }
      default:
        throw new ScriptLookupError(`{{${name}}} is not a lookup`);
    }
  });
}

export type ScriptOutcome = { answer: ScriptAnswer; rule: number } | { miss: string };

export function answerFrom(script: CheckScript, request: ScriptRequest, context: ScriptContext): ScriptOutcome {
  for (const [index, rule] of script.rules.entries()) {
    const matched = matches(rule, request);
    if (!matched) continue;
    try {
      const reply = render(rule.reply, request, context, matched) as ScriptReply;
      return {
        rule: index,
        answer: {
          ...(reply.say ? { say: reply.say } : {}),
          calls: (reply.call ?? []).map((call) => ({ name: call.tool, arguments: call.arguments ?? {} })),
          ...(reply.paceMs ? { paceMs: reply.paceMs } : {}),
        },
      };
    } catch (err) {
      if (err instanceof ScriptLookupError) return { miss: `rule ${index + 1} matched, but ${err.message}` };
      throw err;
    }
  }
  const asked = request.messages.filter((message) => message.role === 'user').at(-1)?.content ?? '';
  return { miss: `the script has no answer for a request offering ${request.tools.length ? request.tools.join(', ') : 'no tools'}, asked "${asked.slice(0, 200)}"` };
}
