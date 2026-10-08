import type { ToolDefinition } from '@koala/agent-engine';
import type { GroupDefinition, NodeCatalogue, Procedure } from '@koala/agent-engine/procedure';
import { procedureBuilder } from '@koala/agent-engine/procedure-builder';

export const TURN_PROCEDURE_ID = 'turn-check';
export const TURN_CALL_KIND = 'call-model';

export type ArgCheck =
  | { arg: string; is: string }
  | { arg: string; contains: string }
  | { arg: string; matches: string }
  | { arg: string; nonEmpty: true };

export interface TurnChoice {
  tool: string | null;
  args?: ArgCheck[] | undefined;
}

export interface TurnReply {
  toolCalls: { name: string; arguments: string }[];
  content: string;
}

export interface Verdict {
  passed: boolean;
  complaint?: string | undefined;
}

export function turnProcedure(catalogue: NodeCatalogue, groups: readonly GroupDefinition[]): Procedure {
  return procedureBuilder({ catalogue, groups })({
    id: TURN_PROCEDURE_ID,
    version: '1',
    name: 'Turn check',
    describe: 'One Model Turn, built exactly as a real run builds it: the agent is offered its tools and nothing it asks for runs.',
    budget: {},
  }, (p) => {
    const input = p.runInput('input');
    const provision = p.provisionSandbox('provision');
    const conversation = p.conversation('conversation', { opening: input.message, given: input.inputs });
    const turn = p.groups.modelTurn('turn', { messages: conversation.messages, environment: provision.environment });
    const answered = p.finish('answered', { result: turn.content }, { outcome: 'ok' });
    const unavailable = p.finish('unavailable', { reason: provision.reason }, { outcome: 'failed' });
    const release = p.releaseSandbox('release', { environment: provision.environment });
    const released = p.finish('released', {}, { outcome: 'ok' });

    p.start(provision);
    p.cleanup(release);
    provision.on('ready', conversation);
    provision.on('unavailable', unavailable);
    conversation.on('done', turn);
    for (const exit of ['toolCalls', 'answered', 'truncated', 'empty'] as const) turn.on(exit, answered);
    release.on('done', released);

    p.layout({
      input: [0, 140],
      provision: [0, 0],
      conversation: [260, 0],
      turn: [520, 0],
      answered: [780, 0],
      unavailable: [260, 140],
      release: [0, 280],
      released: [260, 280],
    });
  }).procedure;
}

const ARG_KINDS = ['is', 'contains', 'matches', 'nonEmpty'] as const;

export function turnChoiceProblems(choice: unknown, tools: readonly ToolDefinition[], where = ''): string[] {
  const given = choice as Partial<TurnChoice> | undefined;
  if (!given || typeof given !== 'object' || (given.tool !== null && typeof given.tool !== 'string')) {
    return [`${where}what it chooses has to name a tool, or null for none`];
  }
  const problems: string[] = [];
  const tool = given.tool === null ? undefined : tools.find((candidate) => candidate.name === given.tool);
  if (given.tool !== null && !tool) problems.push(`${where}it expects the model to choose ${given.tool}, which is not a tool`);
  if (given.tool === null && given.args?.length) problems.push(`${where}a turn that chooses no tool has no arguments to check`);
  if (given.args !== undefined && !Array.isArray(given.args)) return [...problems, `${where}the arguments to check have to be a list`];
  for (const check of given.args ?? []) {
    const kinds = ARG_KINDS.filter((kind) => check && kind in check);
    if (typeof check?.arg !== 'string' || !check.arg || kinds.length !== 1) problems.push(`${where}each argument check names one argument and one of is, contains, matches or nonEmpty`);
    else if (tool && !(check.arg in (tool.parameters.properties ?? {}))) problems.push(`${where}${tool.name} has no argument called "${check.arg}"`);
    else if ('matches' in check) {
      try {
        new RegExp(check.matches);
      } catch {
        problems.push(`${where}"${check.matches}" is not a valid pattern`);
      }
    }
  }
  return problems;
}

const clip = (text: string, max = 120): string => (text.length <= max ? text : `${text.slice(0, max)}…`);

function argComplaint(check: ArgCheck, value: unknown): string | undefined {
  if (value === undefined) return `sent no "${check.arg}"`;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if ('is' in check) {
    if (text === check.is) return undefined;
    const boolean = ['true', 'false'].includes(check.is.toLowerCase());
    if (boolean && text.toLowerCase() === check.is.toLowerCase()) return undefined;
    return `sent "${check.arg}" as ${clip(text, 60)}, wanted ${check.is}`;
  }
  if ('contains' in check) return text.includes(check.contains) ? undefined : `"${check.arg}" does not contain ${JSON.stringify(check.contains)}: ${clip(text, 80)}`;
  if ('matches' in check) return new RegExp(check.matches).test(text) ? undefined : `"${check.arg}" does not match /${check.matches}/: ${clip(text, 80)}`;
  return text.trim() ? undefined : `sent "${check.arg}" empty`;
}

export function scoreTurn(reply: TurnReply, choice: TurnChoice, tool?: ToolDefinition | undefined): Verdict {
  const called = reply.toolCalls.map((made) => made.name);
  const fail = (complaint: string): Verdict => ({ passed: false, complaint });

  if (choice.tool === null) {
    if (called.length > 0) return fail(`called ${called.join(', ')} when it should have called nothing and answered`);
    return reply.content.trim() ? { passed: true } : fail('called nothing and answered nothing — it did not decline, it produced nothing');
  }
  if (reply.toolCalls.length === 0) {
    const said = reply.content.trim();
    return fail(said ? `called no tool, answered instead: "${clip(said)}"` : 'called no tool and said nothing');
  }
  const call = reply.toolCalls.find((made) => made.name === choice.tool);
  if (!call) return fail(`called ${called.join(', ')} instead of ${choice.tool}`);

  let args: Record<string, unknown>;
  try {
    args = call.arguments.trim() ? JSON.parse(call.arguments) as Record<string, unknown> : {};
  } catch {
    return fail(`arguments for ${choice.tool} were not valid JSON: ${clip(call.arguments)}`);
  }

  const missing = (tool?.parameters.required ?? []).filter((name) => args[name] === undefined);
  if (missing.length > 0) return fail(`called ${choice.tool} without ${missing.join(', ')} (sent ${Object.keys(args).join(', ') || 'nothing'})`);
  const known = new Set(Object.keys(tool?.parameters.properties ?? {}));
  const invented = known.size > 0 ? Object.keys(args).filter((name) => !known.has(name)) : [];
  if (invented.length > 0) return fail(`invented arguments ${invented.join(', ')} — the schema offers ${[...known].join(', ')}`);

  for (const check of choice.args ?? []) {
    const complaint = argComplaint(check, args[check.arg]);
    if (complaint) return fail(`${choice.tool} ${complaint}`);
  }
  return { passed: true };
}

export function describeChoice(choice: TurnChoice): string {
  if (choice.tool === null) return 'answers without calling a tool';
  return `chooses ${choice.tool}${choice.args?.length ? ` with ${choice.args.map((check) => check.arg).join(', ')} right` : ''}`;
}
