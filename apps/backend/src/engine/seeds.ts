import type { AgentDefinition } from './agent.js';
import type { LoopGraph } from './graph.js';
import { describeSyntax } from './syntax.js';
import { BUILDER_TOOLS } from './builder-tools-catalogue.js';

export const INTERACTIVE_CHAT: LoopGraph = {
  id: 'interactive-chat',
  version: '1',
  entry: 'think',
  budget: { maxRounds: 12, maxToolCalls: 40 },
  nodes: [
    {
      kind: 'model',
      id: 'think',
      tools: 'granted',
      next: [
        { to: 'work', when: 'not empty(reply.toolCalls)' },
        { to: 'think', when: 'reply.finishReason == "length"' },
        { to: 'answered' },
      ],
    },
    { kind: 'dispatch', id: 'work', next: [{ to: 'think' }] },
    { kind: 'terminal', id: 'answered', outcome: 'ok' },
  ],
};

export const TOOL_ROUNDS: LoopGraph = {
  id: 'tool-rounds',
  version: '1',
  entry: 'work',
  budget: { maxRounds: 20, maxToolCalls: 120, maxWallClockMs: 30 * 60_000 },
  nodes: [
    {
      kind: 'model',
      id: 'work',
      tools: 'granted',
      next: [
        { to: 'act', when: 'not empty(reply.toolCalls)' },
        { to: 'stalled', when: 'empty(reply.content)' },
        { to: 'finished' },
      ],
    },
    { kind: 'dispatch', id: 'act', next: [{ to: 'work' }] },
    { kind: 'terminal', id: 'stalled', outcome: 'failed', reason: 'stopped without saying what it did' },
    { kind: 'terminal', id: 'finished', outcome: 'ok' },
  ],
};

export const PLANNING: LoopGraph = {
  id: 'planning',
  version: '1',
  entry: 'plan',
  budget: { maxRounds: 8, maxToolCalls: 40 },
  nodes: [
    {
      kind: 'model',
      id: 'plan',
      tools: 'granted',
      next: [
        { to: 'circling', when: 'detectors.circling' },
        { to: 'act', when: 'not empty(reply.toolCalls)' },
        { to: 'settled' },
      ],
    },
    { kind: 'dispatch', id: 'act', next: [{ to: 'plan' }] },
    { kind: 'terminal', id: 'circling', outcome: 'ok', reason: 'stopped proposing anything new' },
    { kind: 'terminal', id: 'settled', outcome: 'ok' },
  ],
};

export const RESEARCH: LoopGraph = {
  id: 'research',
  version: '1',
  entry: 'ask',
  budget: { maxRounds: 3, maxToolCalls: 12 },
  nodes: [
    {
      kind: 'model',
      id: 'ask',
      tools: 'granted',
      next: [
        { to: 'look', when: 'not empty(reply.toolCalls)' },
        { to: 'answered' },
      ],
    },
    { kind: 'dispatch', id: 'look', next: [{ to: 'ask' }] },
    { kind: 'terminal', id: 'answered', outcome: 'ok' },
  ],
};

export const SINGLE_SHOT: LoopGraph = {
  id: 'single-shot',
  version: '1',
  entry: 'assess',
  budget: { maxRounds: 1 },
  nodes: [
    { kind: 'model', id: 'assess', tools: 'none', next: [{ to: 'verdict' }] },
    { kind: 'terminal', id: 'verdict', outcome: 'ok' },
  ],
};

export const DELIVERY: LoopGraph = {
  id: 'delivery',
  version: '1',
  entry: 'plan',
  budget: { maxRounds: 40, maxToolCalls: 200, maxWallClockMs: 6 * 60 * 60_000 },
  nodes: [
    { kind: 'agent', id: 'plan', agent: 'planner', as: 'plan', next: [{ to: 'review' }] },
    {
      kind: 'wait',
      id: 'review',
      prompt: 'Here is the proposed work. Accept what you want, then reply to carry on.',
      as: 'review',
      next: [{ to: 'gather' }],
    },
    {
      kind: 'tool',
      id: 'gather',
      tool: 'list_tasks',
      args: { ready: true },
      as: 'ready',
      next: [
        { to: 'work', when: 'not empty(outputs.ready)' },
        { to: 'settled' },
      ],
    },
    { kind: 'fanout', id: 'work', over: 'outputs.ready', agent: 'executor', as: 'done', join: 'regroup' },
    { kind: 'merge', id: 'regroup', next: [{ to: 'gather' }] },
    { kind: 'terminal', id: 'settled', outcome: 'ok' },
  ],
};

export const DO_ONE_TASK: LoopGraph = {
  id: 'do-one-task',
  version: '1',
  entry: 'claim',
  budget: { maxRounds: 20, maxToolCalls: 120, maxWallClockMs: 30 * 60_000 },
  nodes: [
    {
      kind: 'tool',
      id: 'claim',
      tool: 'start_task',
      args: { taskId: '{{inputs.item.id}}' },
      next: [{ to: 'work' }],
    },
    {
      kind: 'model',
      id: 'work',
      tools: 'granted',
      next: [
        { to: 'act', when: 'not empty(reply.toolCalls)' },
        { to: 'check', when: 'not empty(inputs.item.checks.command)' },
        { to: 'judge' },
      ],
    },
    { kind: 'dispatch', id: 'act', next: [{ to: 'work' }] },
    {
      kind: 'tool',
      id: 'check',
      tool: 'run_command',
      args: { command: '{{inputs.item.checks.command}}' },
      as: 'check',
      next: [
        { to: 'judge', when: 'tools' },
      ],
    },
    { kind: 'agent', id: 'judge', agent: 'judge', as: 'verdict', next: [{ to: 'record' }] },
    {
      kind: 'tool',
      id: 'record',
      tool: 'mark_done',
      args: { taskId: '{{inputs.item.id}}', evidence: '{{reply.content}}' },
      next: [{ to: 'finished' }],
    },
    { kind: 'terminal', id: 'finished', outcome: 'ok' },
  ],
};

export const SEEDED_LOOPS: LoopGraph[] = [
  DELIVERY,
  DO_ONE_TASK,
  INTERACTIVE_CHAT,
  TOOL_ROUNDS,
  PLANNING,
  RESEARCH,
  SINGLE_SHOT,
];

export const SEEDED_AGENTS: AgentDefinition[] = [
  {
    slug: 'agent-builder',
    name: 'Agent builder',
    description: 'Writes and edits agents and the loops they run',
    version: '1',
    prompt: [
      'You build agents. Someone tells you what they need one to do, and you write it.',
      '',
      'Work the way you would with a compiler you cannot argue with:',
      '',
      '1. `read_agent` on anything close to what is wanted, to see how it is written.',
      '2. Write the whole text — the agent, and the loop it runs if it needs a new one.',
      '3. `compile_agent`. Fix every problem it reports. Compile again.',
      '4. Only once it compiles clean, `write_agent`.',
      '',
      'Never write without compiling first. The problems come back with line numbers; read them',
      'literally rather than rewriting from scratch.',
      '',
      'Give an agent only the tools its job needs. You cannot grant a tool you do not have',
      'yourself, and a refusal on that is not something to work around.',
      '',
      describeSyntax(),
    ].join('\n'),
    loop: 'tool-rounds',
    tools: ['read_agent', 'compile_agent', 'write_agent'],
    budget: { maxRounds: 20, maxToolCalls: 40 },
    environment: {},
    interface: {
      inputs: { type: 'object', properties: { need: { type: 'string' } }, required: ['need'] },
      outputs: ['agent', 'summary'],
    },
  },
  {
    slug: 'delivery',
    name: 'Delivery',
    description: 'Plans a goal, waits for you to accept the work, then sees it through',
    version: '1',
    prompt: 'You see a goal through from plan to finished work.',
    loop: 'delivery',
    tools: [],
    agents: ['planner', 'executor', 'judge', 'research'],
    budget: { maxRounds: 40, maxToolCalls: 200, maxWallClockMs: 6 * 60 * 60_000 },
    environment: {},
    interface: {
      inputs: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] },
      outputs: ['done'],
    },
  },
  {
    slug: 'koala',
    name: 'Koala',
    description: 'Talks things through and works out what needs doing',
    version: '1',
    prompt: 'You help the person you are talking to work out what they want and how to get it. Ask before assuming. When work needs doing, delegate it rather than guessing at it yourself.',
    loop: 'interactive-chat',
    tools: [],
    agents: ['planner', 'research'],
    budget: { maxRounds: 12, maxToolCalls: 40 },
    environment: {},
    interface: { inputs: { type: 'object', properties: { message: { type: 'string' } } } },
  },
  {
    slug: 'planner',
    name: 'Planner',
    description: 'Breaks a goal into units of work that can be checked',
    version: '1',
    prompt: 'You break a goal into units of work. Each one must be small enough to finish in a single sitting and specific enough that someone can tell whether it worked. Say what "done" means for each. Delegate questions you cannot answer from what you already know.',
    loop: 'planning',
    tools: [],
    agents: ['research'],
    budget: { maxRounds: 8, maxToolCalls: 40 },
    environment: {},
    interface: {
      inputs: { type: 'object', properties: { goal: { type: 'string' } } },
      outputs: ['proposals'],
    },
  },
  {
    slug: 'research',
    name: 'Research',
    description: 'Answers a question from the web and cites where the answer came from',
    version: '1',
    prompt: 'You answer one question using the web. Cite where each claim came from. If you cannot find an answer, say so plainly rather than guessing.',
    loop: 'research',
    tools: [],
    budget: { maxRounds: 3, maxToolCalls: 12 },
    environment: { egress: true },
    interface: {
      inputs: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
      outputs: ['findings', 'sources'],
    },
  },
  {
    slug: 'executor',
    name: 'Executor',
    description: 'Does a unit of work on a machine and reports what it changed',
    version: '1',
    prompt: 'You carry out one unit of work on a real machine. Check what is actually there before changing anything. When you are done, say what you changed and how you verified it.',
    loop: 'do-one-task',
    tools: [],
    agents: ['judge'],
    budget: { maxRounds: 20, maxToolCalls: 120, maxWallClockMs: 30 * 60_000 },
    environment: { terminal: true, filesystem: true, workspace: true },
    interface: {
      inputs: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
      outputs: ['summary', 'changed'],
      workspace: true,
    },
  },
  {
    slug: 'judge',
    name: 'Judge',
    description: 'Decides whether finished work actually meets what was asked',
    version: '1',
    prompt: 'You decide whether a piece of finished work meets what was asked of it. Judge only what the evidence shows. If the evidence does not settle it, say it is unproven rather than assuming either way.',
    loop: 'single-shot',
    tools: [],
    budget: { maxRounds: 1 },
    environment: {},
    interface: {
      inputs: { type: 'object', properties: { work: { type: 'string' }, expected: { type: 'string' } } },
      outputs: ['verdict', 'reasoning'],
    },
  },
];

export const seededAgentSlugs = (): Set<string> => new Set(SEEDED_AGENTS.map((agent) => agent.slug));

export const definedToolNames = (): Set<string> => new Set(BUILDER_TOOLS.map((tool) => tool.name));

export const loopsPendingTools = (): { loop: string; missing: string[] }[] => {
  const have = definedToolNames();

  return SEEDED_LOOPS
    .map((loop) => ({
      loop: loop.id,
      missing: loop.nodes
        .filter((node): node is Extract<typeof node, { kind: 'tool' }> => node.kind === 'tool')
        .map((node) => node.tool)
        .filter((tool) => !have.has(tool)),
    }))
    .filter((entry) => entry.missing.length > 0);
};
export const seededLoopIds = (): Set<string> => new Set(SEEDED_LOOPS.map((loop) => loop.id));
