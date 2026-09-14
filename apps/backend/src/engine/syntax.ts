import type { AgentDefinition, EgressMode } from './agent.js';
import type { Edge, LoopGraph, LoopNode, NodeId } from './graph.js';
import type { RunBudget } from './run.js';

export interface SyntaxProblem {
  line: number;
  message: string;
}

export interface SourceLines {
  loop: Record<string, number>;
  agent: Record<string, number>;
  node: Record<string, number>;
}

export interface ParsedSource {
  loops: LoopGraph[];
  agents: AgentDefinition[];
  problems: SyntaxProblem[];
  lines: SourceLines;
}

export const nodeKey = (loopId: string, nodeId: string): string => `${loopId}.${nodeId}`;

interface Line {
  n: number;
  depth: number;
  text: string;
}

const INDENT = 2;

const NODE_KINDS = [
  'model', 'tool', 'agent', 'dispatch', 'wait',
  'branch', 'fanout', 'parallel', 'merge', 'terminal',
] as const;

type NodeKind = (typeof NODE_KINDS)[number];

const NODE_FIELDS: Record<NodeKind, string[]> = {
  model: ['tools', 'toolChoice', 'think', 'maxTokens', 'reasoningEffort'],
  tool: ['tool', 'args', 'as'],
  agent: ['agent', 'inputs', 'as'],
  dispatch: ['as'],
  wait: ['prompt', 'as', 'timeoutMs'],
  branch: [],
  fanout: ['over', 'agent', 'join', 'maxParallel', 'as'],
  parallel: ['branches', 'join'],
  merge: ['strategy', 'as'],
  terminal: ['outcome', 'reason'],
};

const SUBJECT_FIELD: Partial<Record<NodeKind, string>> = {
  tool: 'tool',
  agent: 'agent',
  wait: 'prompt',
  merge: 'strategy',
  terminal: 'outcome',
};

const FIELD_ALIAS: Record<string, string> = {
  'max-tokens': 'maxTokens',
  effort: 'reasoningEffort',
  choice: 'toolChoice',
  timeout: 'timeoutMs',
  parallel: 'maxParallel',
};

const OBJECT_FIELDS = new Set(['args', 'inputs']);
const LIST_FIELDS = new Set(['branches', 'tools', 'agents', 'outputs', 'needs']);

function scan(source: string): { lines: Line[]; problems: SyntaxProblem[] } {
  const lines: Line[] = [];
  const problems: SyntaxProblem[] = [];

  source.split('\n').forEach((raw, index) => {
    const n = index + 1;
    const withoutComment = raw.replace(/(^|\s)#.*$/, '$1');
    if (!withoutComment.trim()) return;

    const leading = withoutComment.length - withoutComment.trimStart().length;
    if (withoutComment.slice(0, leading).includes('\t')) {
      problems.push({ line: n, message: 'indent with spaces, not tabs' });
      return;
    }
    if (leading % INDENT !== 0) {
      problems.push({ line: n, message: `indent in steps of ${INDENT} spaces (found ${leading})` });
      return;
    }

    lines.push({ n, depth: leading / INDENT, text: withoutComment.trim() });
  });

  return { lines, problems };
}

function readValue(raw: string): unknown {
  const text = raw.trim();
  if (!text) return true;
  if (/^".*"$/.test(text)) return text.slice(1, -1);
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  return text;
}

const splitList = (raw: string): string[] =>
  raw.split(',').map((part) => part.trim()).filter(Boolean);

function readBudget(raw: string): RunBudget {
  const budget: RunBudget = {};
  const map: Record<string, keyof RunBudget> = {
    rounds: 'maxRounds',
    'tool-calls': 'maxToolCalls',
    tokens: 'maxTokens',
    depth: 'maxDepth',
    children: 'maxChildRuns',
    ms: 'maxWallClockMs',
  };

  for (const part of splitList(raw)) {
    const [key, value] = part.split(/\s+/);
    const field = key ? map[key] : undefined;
    if (field && value !== undefined) budget[field] = Number(value);
  }

  return budget;
}

function block(lines: Line[], from: number, depth: number): { body: Line[]; next: number } {
  let cursor = from;
  while (cursor < lines.length && lines[cursor]!.depth >= depth) cursor += 1;
  return { body: lines.slice(from, cursor), next: cursor };
}

function readObject(body: Line[], problems: SyntaxProblem[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of body) {
    const [key, ...rest] = line.text.split(/\s+/);
    if (!key) continue;
    if (rest.length === 0) {
      problems.push({ line: line.n, message: `"${key}" has no value` });
      continue;
    }
    out[key] = readValue(rest.join(' '));
  }
  return out;
}

function readBlockScalar(body: Line[]): string {
  if (body.length === 0) return '';
  const base = Math.min(...body.map((line) => line.depth));
  return body
    .map((line) => `${'  '.repeat(line.depth - base)}${line.text}`)
    .join('\n');
}

function parseNode(head: Line, body: Line[], problems: SyntaxProblem[]): LoopNode | undefined {
  const colon = head.text.indexOf(':');
  const id = head.text.slice(0, colon).trim();
  const declaration = head.text.slice(colon + 1).trim();
  const [kindWord, ...subjectWords] = declaration.split(/\s+/);

  if (!id) {
    problems.push({ line: head.n, message: 'a node needs an id before the colon' });
    return undefined;
  }
  if (!kindWord || !(NODE_KINDS as readonly string[]).includes(kindWord)) {
    problems.push({
      line: head.n,
      message: `"${kindWord ?? ''}" is not a node kind — expected one of ${NODE_KINDS.join(', ')}`,
    });
    return undefined;
  }

  const kind = kindWord as NodeKind;
  const node: Record<string, unknown> = { kind, id };

  const subject = subjectWords.join(' ').trim();
  if (subject) {
    const field = SUBJECT_FIELD[kind];
    if (!field) {
      problems.push({ line: head.n, message: `a ${kind} node takes no subject, but found "${subject}"` });
    } else {
      node[field] = readValue(subject);
    }
  }

  const edges: Edge[] = [];
  let index = 0;

  while (index < body.length) {
    const line = body[index]!;

    if (line.depth !== head.depth + 1) {
      problems.push({ line: line.n, message: 'unexpected indent inside a node' });
      index += 1;
      continue;
    }

    if (line.text.startsWith('->')) {
      const rest = line.text.slice(2).trim();
      const when = rest.match(/\s+when\s+(.+)$/);
      const to = (when ? rest.slice(0, when.index) : rest).trim();

      if (!to) problems.push({ line: line.n, message: 'an edge needs a target node' });
      else edges.push({ to, ...(when?.[1] ? { when: when[1].trim() } : {}) });

      index += 1;
      continue;
    }

    const [rawKey, ...rest] = line.text.split(/\s+/);
    const key = rawKey ? (FIELD_ALIAS[rawKey] ?? rawKey) : '';
    const value = rest.join(' ');

    if (!NODE_FIELDS[kind].includes(key)) {
      const legal = NODE_FIELDS[kind].map((field) => REVERSE_ALIAS[field] ?? field);
      problems.push({
        line: line.n,
        message: legal.length === 0
          ? `a ${kind} node takes no settings, but found "${rawKey}"`
          : `a ${kind} node has no "${rawKey}" setting — it takes ${legal.join(', ')}`,
      });
      index += 1;
      continue;
    }

    if (OBJECT_FIELDS.has(key) && !value) {
      const nested = block(body, index + 1, line.depth + 1);
      node[key] = readObject(nested.body, problems);
      index = nested.next;
      continue;
    }

    if (LIST_FIELDS.has(key)) {
      node[key] = splitList(value);
      index += 1;
      continue;
    }

    node[key] = readValue(value);
    index += 1;
  }

  if (edges.length > 0) node.next = edges;
  return node as unknown as LoopNode;
}

function parseLoop(
  head: Line,
  body: Line[],
  problems: SyntaxProblem[],
  lines: SourceLines,
): LoopGraph {
  const [, id, version] = head.text.split(/\s+/);
  const graph: LoopGraph = {
    id: id ?? '',
    version: (version ?? 'v1').replace(/^v/, ''),
    entry: '',
    nodes: [],
  };

  if (!id) problems.push({ line: head.n, message: 'a loop needs a name' });

  let index = 0;
  while (index < body.length) {
    const line = body[index]!;

    if (line.depth !== head.depth + 1) {
      problems.push({ line: line.n, message: 'unexpected indent inside a loop' });
      index += 1;
      continue;
    }

    if (line.text.includes(':')) {
      const nested = block(body, index + 1, line.depth + 1);
      const node = parseNode(line, nested.body, problems);
      if (node) {
        graph.nodes.push(node);
        lines.node[nodeKey(graph.id, node.id)] = line.n;
      }
      index = nested.next;
      continue;
    }

    const [key, ...rest] = line.text.split(/\s+/);
    const value = rest.join(' ');

    if (key === 'entry') graph.entry = value;
    else if (key === 'budget') graph.budget = readBudget(value);
    else if (key === 'requires') {
      graph.requires = Object.fromEntries(splitList(value).map((need) => [need, true]));
    } else problems.push({ line: line.n, message: `a loop has no "${key}" setting` });

    index += 1;
  }

  if (!graph.entry && graph.nodes[0]) graph.entry = graph.nodes[0].id;
  return graph;
}

function parseAgent(head: Line, body: Line[], problems: SyntaxProblem[]): AgentDefinition {
  const [, slug, version] = head.text.split(/\s+/);
  const agent: AgentDefinition = {
    slug: slug ?? '',
    name: slug ?? '',
    description: '',
    version: (version ?? 'v1').replace(/^v/, ''),
    prompt: '',
    loop: '',
    tools: [],
    budget: {},
    environment: {},
  };

  if (!slug) problems.push({ line: head.n, message: 'an agent needs a name' });

  let index = 0;
  while (index < body.length) {
    const line = body[index]!;
    const [key, ...rest] = line.text.split(/\s+/);
    const value = rest.join(' ');

    if (value === '>') {
      const nested = block(body, index + 1, line.depth + 1);
      if (key === 'prompt') agent.prompt = readBlockScalar(nested.body);
      else problems.push({ line: line.n, message: `"${key}" is not a text block` });
      index = nested.next;
      continue;
    }

    switch (key) {
      case 'name': agent.name = value; break;
      case 'describe': agent.description = value; break;
      case 'loop': agent.loop = value; break;
      case 'tools': agent.tools = splitList(value); break;
      case 'agents': agent.agents = splitList(value); break;
      case 'budget': agent.budget = readBudget(value); break;
      case 'egress': agent.egressMode = value as EgressMode; break;
      case 'outputs':
        agent.interface = { ...agent.interface, outputs: splitList(value) };
        break;
      case 'needs':
        agent.environment = Object.fromEntries(splitList(value).map((need) => [need, true]));
        break;
      case 'languages':
        agent.environment = { ...agent.environment, languages: splitList(value) };
        break;
      default:
        problems.push({ line: line.n, message: `an agent has no "${key}" setting` });
    }

    index += 1;
  }

  if (agent.environment.workspace) {
    agent.interface = { ...agent.interface, workspace: true };
  }

  return agent;
}

export function parseSource(source: string): ParsedSource {
  const { lines, problems } = scan(source);
  const loops: LoopGraph[] = [];
  const agents: AgentDefinition[] = [];
  const at: SourceLines = { loop: {}, agent: {}, node: {} };

  let index = 0;
  while (index < lines.length) {
    const head = lines[index]!;

    if (head.depth !== 0) {
      problems.push({ line: head.n, message: 'expected a "loop" or "agent" block at the left margin' });
      index += 1;
      continue;
    }

    const nested = block(lines, index + 1, 1);
    const word = head.text.split(/\s+/)[0];

    if (word === 'loop') {
      const loop = parseLoop(head, nested.body, problems, at);
      at.loop[loop.id] = head.n;
      loops.push(loop);
    } else if (word === 'agent') {
      const agent = parseAgent(head, nested.body, problems);
      at.agent[agent.slug] = head.n;
      agents.push(agent);
    } else {
      problems.push({ line: head.n, message: `"${word}" is not a block — expected "loop" or "agent"` });
    }

    index = nested.next;
  }

  return { loops, agents, problems, lines: at };
}

const REVERSE_ALIAS: Record<string, string> = Object.fromEntries(
  Object.entries(FIELD_ALIAS).map(([text, field]) => [field, text]),
);

const SKIP_WHEN_FORMATTING = new Set(['kind', 'id', 'next']);

function formatValue(value: unknown): string {
  if (typeof value === 'string' && (value.includes(' ') && !value.includes('{{'))) return `"${value}"`;
  return String(value);
}

function formatBudget(budget: RunBudget): string {
  const map: Array<[keyof RunBudget, string]> = [
    ['maxRounds', 'rounds'],
    ['maxToolCalls', 'tool-calls'],
    ['maxTokens', 'tokens'],
    ['maxDepth', 'depth'],
    ['maxChildRuns', 'children'],
    ['maxWallClockMs', 'ms'],
  ];

  return map
    .filter(([field]) => budget[field] !== undefined)
    .map(([field, text]) => `${text} ${budget[field]}`)
    .join(', ');
}

export function formatLoop(graph: LoopGraph): string {
  const out: string[] = [`loop ${graph.id} v${graph.version}`];

  if (graph.budget && formatBudget(graph.budget)) out.push(`  budget ${formatBudget(graph.budget)}`);
  if (graph.requires) {
    const needs = Object.entries(graph.requires).filter(([, on]) => on).map(([need]) => need);
    if (needs.length > 0) out.push(`  requires ${needs.join(', ')}`);
  }
  out.push(`  entry ${graph.entry}`);

  for (const node of graph.nodes) {
    const fields = node as unknown as Record<string, unknown>;
    const subjectField = SUBJECT_FIELD[node.kind as NodeKind];
    const subject = subjectField ? fields[subjectField] : undefined;

    out.push('');
    out.push(`  ${node.id}: ${node.kind}${subject === undefined ? '' : ` ${formatValue(subject)}`}`);

    for (const [key, value] of Object.entries(fields)) {
      if (SKIP_WHEN_FORMATTING.has(key) || key === subjectField || value === undefined) continue;

      const name = REVERSE_ALIAS[key] ?? key;

      if (OBJECT_FIELDS.has(name) && value && typeof value === 'object') {
        out.push(`    ${name}`);
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          out.push(`      ${k} ${formatValue(v)}`);
        }
        continue;
      }

      out.push(`    ${name} ${Array.isArray(value) ? value.join(', ') : formatValue(value)}`);
    }

    for (const edge of (node as { next?: Edge[] }).next ?? []) {
      out.push(`    -> ${edge.to}${edge.when ? ` when ${edge.when}` : ''}`);
    }
  }

  return `${out.join('\n')}\n`;
}

export function nodeIds(graph: LoopGraph): NodeId[] {
  return graph.nodes.map((node) => node.id);
}

export function describeSyntax(): string {
  const kinds = NODE_KINDS.map((kind) => {
    const subject = SUBJECT_FIELD[kind];
    const rest = NODE_FIELDS[kind]
      .filter((field) => field !== subject)
      .map((field) => REVERSE_ALIAS[field] ?? field);

    const head = subject ? `${kind} <${REVERSE_ALIAS[subject] ?? subject}>` : kind;
    return `  ${head.padEnd(22)}${rest.length ? rest.join(', ') : '—'}`;
  });

  return [
    'THE LOOP SYNTAX',
    '',
    'Three rules, and that is the whole grammar:',
    '',
    '1. `id: kind [subject]` opens a node. The subject is what that node is about.',
    '2. Indented `name value` lines are its settings. A setting with no value opens a nested',
    '   object (args, inputs). `prompt >` opens a block of text on the lines below it.',
    '3. `-> target when <condition>` is an edge; `-> target` with no condition is the fallthrough.',
    '   Edges are tried in the order written, so the first one that matches wins.',
    '',
    'Indent in steps of two spaces. `#` starts a comment. Values written {{like.this}} are',
    'substituted from run state; conditions after `when` are written bare.',
    '',
    'NODE KINDS AND THEIR SETTINGS',
    '',
    ...kinds,
    '',
    'A loop takes: entry, budget (rounds, tool-calls, tokens, depth, children, ms), requires.',
    'An agent takes: name, describe, loop, needs, languages, tools, agents, outputs, budget,',
    'egress, prompt.',
    '',
    'WORKED EXAMPLE',
    '',
    'loop review v1',
    '  budget rounds 8',
    '  entry look',
    '',
    '  look: tool read_file',
    '    args',
    '      path {{inputs.path}}',
    '    as source',
    '    -> think',
    '',
    '  think: model',
    '    tools granted',
    '    -> work when not empty(reply.toolCalls)',
    '    -> done',
    '',
    '  work: dispatch',
    '    -> think',
    '',
    '  done: terminal ok',
    '',
    'agent reviewer v1',
    '  describe Reviews a file and reports what is wrong',
    '  loop     review',
    '  needs    filesystem',
    '  tools    read_file',
    '  outputs  findings',
    '  prompt >',
    '    You review code. Report only what you can point at.',
  ].join('\n');
}

export function formatAgent(agent: AgentDefinition): string {
  const out: string[] = [`agent ${agent.slug} v${agent.version}`];
  const line = (key: string, value: string | undefined) => {
    if (value) out.push(`  ${key} ${value}`);
  };

  if (agent.name && agent.name !== agent.slug) line('name', agent.name);
  line('describe', agent.description);
  line('loop', agent.loop);

  const needs = Object.entries(agent.environment)
    .filter(([key, on]) => on === true && key !== 'languages')
    .map(([key]) => key);
  if (needs.length > 0) line('needs', needs.join(', '));
  if (agent.environment.languages?.length) line('languages', agent.environment.languages.join(', '));

  if (agent.tools.length > 0) line('tools', agent.tools.join(', '));
  if (agent.agents?.length) line('agents', agent.agents.join(', '));
  if (agent.interface?.outputs?.length) line('outputs', agent.interface.outputs.join(', '));

  const budget = formatBudget(agent.budget);
  if (budget) line('budget', budget);
  line('egress', agent.egressMode);

  if (agent.prompt.trim()) {
    out.push('  prompt >');
    for (const text of agent.prompt.split('\n')) out.push(`    ${text}`);
  }

  return `${out.join('\n')}\n`;
}
