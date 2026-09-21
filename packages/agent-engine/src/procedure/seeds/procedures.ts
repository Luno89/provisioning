import type { RunOutcome } from '../../runtime/events.js';
import type { Procedure } from '../schema.js';
import { defineProcedure } from './define.js';
import { BUILT_IN_GROUPS } from './groups.js';

interface Ending {
  outcome: Extract<RunOutcome, 'ok' | 'failed' | 'refused'>;
  reason?: string | undefined;
}

interface AgentLoopShape {
  id: string;
  name: string;
  describe: string;
  answered: Ending;
  truncated: 'continue' | Ending;
  empty: Ending;
  circling: Ending;
}

const ending = (shape: Ending) => ({ outcome: shape.outcome, ...(shape.reason ? { reason: shape.reason } : {}) });

function agentLoop(shape: AgentLoopShape): Procedure {
  return defineProcedure(BUILT_IN_GROUPS, { id: shape.id, version: '2', name: shape.name, describe: shape.describe, budget: {} }, (p) => {
    const input = p.runInput('input');
    const provision = p.provisionSandbox('provision');
    const conversation = p.conversation('conversation', { opening: input.message, given: input.inputs });
    const turn = p.groups.modelTurn('turn', { messages: conversation.messages, environment: provision.environment });
    const repetition = p.checkRepetition('repetition', { reply: turn.reply });
    const tools = p.groups.toolLoop('tools', { reply: turn.reply, persona: turn.persona, environment: provision.environment });
    const answered = p.finish('answered', { result: turn.content }, ending(shape.answered));
    const truncated = shape.truncated === 'continue' ? undefined : p.finish('truncated', { result: turn.content }, ending(shape.truncated));
    const saidSomething = truncated ? p.condition('saidSomething', { value: turn.content }, { expression: 'not empty(value)' }) : undefined;
    const cutOff = truncated
      ? p.finish('cutOff', {}, { outcome: 'failed', reason: 'the reply hit the token cap before it said anything' })
      : undefined;
    const empty = p.finish('empty', {}, ending(shape.empty));
    const circling = p.finish('circling', { reason: repetition.reason }, ending(shape.circling));
    const failing = p.finish('failing', { reason: tools.reason }, { outcome: 'failed' });
    const unavailable = p.finish('unavailable', { reason: provision.reason }, { outcome: 'failed' });
    const release = p.releaseSandbox('release', { environment: provision.environment });
    const released = p.finish('released', {}, { outcome: 'ok' });

    conversation.wire({ replies: [turn.reply], results: [tools.refused, tools.results] });

    p.start(provision);
    p.cleanup(release);
    provision.on('ready', conversation);
    provision.on('unavailable', unavailable);
    conversation.on('done', turn);
    turn.on('toolCalls', repetition);
    turn.on('answered', answered);
    turn.on('truncated', saidSomething ?? conversation);
    if (saidSomething && truncated && cutOff) {
      saidSomething.on('true', truncated);
      saidSomething.on('false', cutOff);
    }
    turn.on('empty', empty);
    repetition.on('ok', tools);
    repetition.on('tripped', circling);
    tools.on('done', conversation);
    tools.on('refused', conversation);
    tools.on('failing', failing);
    release.on('done', released);

    p.layout({
      input: [0, 140],
      provision: [0, 0],
      conversation: [260, 0],
      turn: [520, 0],
      repetition: [780, 0],
      tools: [1040, 0],
      answered: [780, 140],
      ...(truncated ? { saidSomething: [780, 280] as const, truncated: [1040, 280] as const, cutOff: [1040, 340] as const } : {}),
      empty: [780, 420],
      circling: [1040, 140],
      failing: [1300, 140],
      unavailable: [260, 140],
      release: [0, 560],
      released: [260, 560],
    });
  });
}

export const TOOL_ROUNDS_V2 = agentLoop({
  id: 'tool-rounds',
  name: 'Tool rounds',
  describe: 'Lets the model work: it calls the tools it needs, round after round, and finishes once it answers without asking for any.',
  answered: { outcome: 'ok' },
  truncated: { outcome: 'ok' },
  empty: { outcome: 'failed', reason: 'stopped without saying what it did' },
  circling: { outcome: 'failed' },
});

export const INTERACTIVE_CHAT_V3 = defineProcedure(BUILT_IN_GROUPS, {
  id: 'interactive-chat',
  version: '3',
  name: 'Interactive chat',
  describe: 'One turn of a conversation that is remembered: it reads back what was said before, answers with tools as needed, carries on when its reply is cut off, and writes the turn back so the next one picks up where this left off.',
  budget: {},
}, (p) => {
  const input = p.runInput('input');
  const provision = p.provisionSandbox('provision');
  const earlier = p.loadConversation('earlier', { values: input.inputs }, { id: '{{values.conversationId}}' });
  const conversation = p.conversation('conversation', {
    opening: input.message,
    history: earlier.messages,
  });
  const turn = p.groups.modelTurn('turn', { messages: conversation.messages, environment: provision.environment });
  const repetition = p.checkRepetition('repetition', { reply: turn.reply });
  const tools = p.groups.toolLoop('tools', { reply: turn.reply, persona: turn.persona, environment: provision.environment });
  const saidSomething = p.condition('saidSomething', { value: turn.content }, { expression: 'not empty(value)' });
  const remember = p.saveConversation('remember', {
    values: input.inputs,
    asked: input.message,
    reply: turn.reply,
    results: tools.results,
  }, { id: '{{values.conversationId}}' });

  const answered = p.finish('answered', { result: turn.content }, { outcome: 'ok' });
  const cutOff = p.finish('cutOff', {}, { outcome: 'failed', reason: 'the reply hit the token cap before it said anything' });
  const empty = p.finish('empty', {}, { outcome: 'ok' });
  const circling = p.finish('circling', { reason: repetition.reason }, { outcome: 'failed' });
  const failing = p.finish('failing', { reason: tools.reason }, { outcome: 'failed' });
  const unavailable = p.finish('unavailable', { reason: provision.reason }, { outcome: 'failed' });
  const release = p.releaseSandbox('release', { environment: provision.environment });
  const released = p.finish('released', {}, { outcome: 'ok' });

  conversation.wire({ replies: [turn.reply], results: [tools.refused, tools.results] });

  p.start(provision);
  p.cleanup(remember);
  provision.on('ready', conversation);
  provision.on('unavailable', unavailable);
  conversation.on('done', turn);
  turn.on('toolCalls', repetition);
  turn.on('answered', answered);
  turn.on('truncated', saidSomething);
  saidSomething.on('true', answered);
  saidSomething.on('false', cutOff);
  turn.on('empty', empty);
  repetition.on('ok', tools);
  repetition.on('tripped', circling);
  tools.on('done', conversation);
  tools.on('refused', conversation);
  tools.on('failing', failing);
  remember.on('saved', release);
  remember.on('failed', release);
  release.on('done', released);

  p.layout({
    input: [0, 140],
    provision: [0, 0],
    earlier: [260, 0],
    conversation: [520, 0],
    turn: [780, 0],
    repetition: [1040, 0],
    tools: [1300, 0],
    saidSomething: [1040, 280],
    remember: [0, 560],
    answered: [1300, 140],
    cutOff: [1300, 280],
    empty: [1040, 420],
    circling: [1300, 60],
    failing: [1560, 0],
    unavailable: [260, 140],
    release: [260, 560],
    released: [520, 560],
  });
});

export const PLANNING_V2 = agentLoop({
  id: 'planning',
  name: 'Planning',
  describe: 'The model proposes work, using tools to look things up, and settles once it stops proposing anything new.',
  answered: { outcome: 'ok' },
  truncated: { outcome: 'ok' },
  empty: { outcome: 'ok' },
  circling: { outcome: 'ok', reason: 'stopped proposing anything new' },
});

export const RESEARCH_V2 = agentLoop({
  id: 'research',
  name: 'Research',
  describe: 'The model looks things up in a few rounds and answers.',
  answered: { outcome: 'ok' },
  truncated: { outcome: 'ok' },
  empty: { outcome: 'ok' },
  circling: { outcome: 'failed' },
});

export const SINGLE_SHOT_V2 = defineProcedure(BUILT_IN_GROUPS, {
  id: 'single-shot',
  version: '2',
  name: 'Single shot',
  describe: 'One call to the model with no tools, laid out node by node rather than as a Model Turn, so every part of the call is visible.',
  budget: {},
}, (p) => {
  const provision = p.provisionSandbox('provision');
  const input = p.runInput('input');
  const conversation = p.conversation('conversation', { opening: input.message, given: input.inputs });
  const persona = p.persona('persona');
  const model = p.chooseModel('model', { persona: persona.persona });
  const tools = p.resolveTools('tools', { persona: persona.persona, delegates: persona.delegates, environment: provision.environment }, { offer: 'none' });
  const environment = p.describeEnvironment('environment', { environment: provision.environment, delegates: persona.delegates });
  const toolText = p.describeTools('toolText', { offered: tools.offered, withheld: tools.withheld, environment: provision.environment });
  const memory = p.recallMemory('memory');
  const outputs = p.describeOutputs('outputs', { persona: persona.persona });
  const context = p.buildContext('context', { sections: [persona.prompt, environment.text, toolText.text, memory.text, outputs.text] });
  const fit = p.fitReplyBudget('fit', { binding: model.binding, system: context.text, messages: conversation.messages });
  const call = p.callModel('call', {
    binding: model.binding,
    system: context.text,
    messages: conversation.messages,
    tools: tools.offered,
    maxTokens: fit.maxTokens,
  });
  const verdict = p.finish('verdict', { result: call.content }, { outcome: 'ok' });
  const unavailable = p.finish('unavailable', { reason: provision.reason }, { outcome: 'failed' });
  const release = p.releaseSandbox('release', { environment: provision.environment });
  const released = p.finish('released', {}, { outcome: 'ok' });

  p.start(provision);
  p.cleanup(release);
  provision.on('ready', conversation);
  provision.on('unavailable', unavailable);
  conversation.on('done', call);
  call.on('toolCalls', verdict);
  call.on('answered', verdict);
  call.on('truncated', verdict);
  call.on('empty', verdict);
  release.on('done', released);

  p.layout({
    provision: [0, 0],
    input: [0, 140],
    conversation: [260, 0],
    persona: [260, 280],
    model: [520, 280],
    tools: [520, 420],
    environment: [520, 560],
    toolText: [780, 420],
    memory: [520, 700],
    outputs: [520, 840],
    context: [1040, 560],
    fit: [1300, 280],
    call: [1560, 0],
    verdict: [1820, 0],
    unavailable: [260, 140],
    release: [0, 980],
    released: [260, 980],
  });
});

export const DO_ONE_TASK_V2 = defineProcedure(BUILT_IN_GROUPS, {
  id: 'do-one-task',
  version: '2',
  name: 'Do one task',
  describe: 'Claims one task, works it with tools until the model is done, runs the task\'s own check if it has one, has the judge weigh the work and the check against what the task asked for, has a model read the verdict, and marks the task done or failed.',
  budget: {},
}, (p) => {
  const provision = p.provisionSandbox('provision');
  const input = p.runInput('input');
  const persona = p.persona('persona');
  const onTask = { values: input.inputs, persona: persona.persona, environment: provision.environment };
  const claim = p.callTool('claim', onTask, {
    tool: 'start_task',
    args: '{"taskId":"{{values.item.id}}"}',
    says: 'The task has already been claimed for you.',
  });
  const conversation = p.conversation('conversation', { opening: input.message, given: input.inputs });
  const turn = p.groups.modelTurn('turn', { messages: conversation.messages, environment: provision.environment });
  const repetition = p.checkRepetition('repetition', { reply: turn.reply });
  const tools = p.groups.toolLoop('tools', { reply: turn.reply, persona: persona.persona, environment: provision.environment });
  const hasCheck = p.condition('hasCheck', { value: input.inputs }, { expression: 'not empty(value.item.checks.command)' });
  const check = p.callTool('check', onTask, {
    tool: 'run_command',
    args: '{"command":"{{values.item.checks.command}}"}',
    shared: true,
  });
  const evidence = p.buildContext('evidence', { sections: [turn.content, check.text] });
  const judge = p.delegate('judge', { values: input.inputs, text: evidence.text, environment: provision.environment }, {
    agent: 'judge',
    inputs: '{"work":"{{text}}","expected":"{{values.item.doneMeans}}"}',
    says: 'When you finish, a judge weighs your work against what the task asked for. You do not have to ask it yourself.',
  });
  const model = p.chooseModel('model', { persona: persona.persona });
  const verdict = p.decide('verdict', { binding: model.binding, text: judge.outputs }, {
    question: 'Does this verdict say the work meets what was expected? Answer no if it is unproven or only partly done.',
  });
  const record = p.callTool('record', { ...onTask, text: turn.content }, {
    tool: 'mark_done',
    args: '{"taskId":"{{values.item.id}}","evidence":"{{text}}"}',
    says: 'The outcome is then recorded on the task for you. Do not record it yourself.',
  });
  const rejected = p.callTool('rejected', { ...onTask, text: verdict.why }, {
    tool: 'mark_failed',
    args: '{"taskId":"{{values.item.id}}","reason":"{{text}}"}',
    says: 'The outcome is then recorded on the task for you. Do not record it yourself.',
  });
  const unjudged = p.callTool('unjudged', { ...onTask, text: judge.reason }, {
    tool: 'mark_failed',
    args: '{"taskId":"{{values.item.id}}","reason":"the work could not be judged: {{text}}"}',
    says: 'The outcome is then recorded on the task for you. Do not record it yourself.',
  });
  const finished = p.finish('finished', {}, { outcome: 'ok' });
  const didNotPass = p.finish('didNotPass', {}, { outcome: 'failed', reason: 'the judge did not accept the work' });
  const couldNotJudge = p.finish('couldNotJudge', {}, { outcome: 'failed', reason: 'the work could not be judged' });
  const notRecorded = p.finish('notRecorded', { reason: record.text }, { outcome: 'failed', reason: 'the outcome could not be recorded on the task' });
  const notClaimed = p.finish('notClaimed', { reason: claim.text }, { outcome: 'failed' });
  const empty = p.finish('empty', {}, { outcome: 'failed', reason: 'stopped without saying what it did' });
  const circling = p.finish('circling', { reason: repetition.reason }, { outcome: 'failed' });
  const failing = p.finish('failing', { reason: tools.reason }, { outcome: 'failed' });
  const unavailable = p.finish('unavailable', { reason: provision.reason }, { outcome: 'failed' });
  const release = p.releaseSandbox('release', { environment: provision.environment });
  const released = p.finish('released', {}, { outcome: 'ok' });

  conversation.wire({ replies: [turn.reply], results: [tools.refused, tools.results] });

  p.start(provision);
  p.cleanup(release);
  provision.on('ready', claim);
  provision.on('unavailable', unavailable);
  claim.on('ok', conversation);
  claim.on('failed', notClaimed);
  conversation.on('done', turn);
  turn.on('toolCalls', repetition);
  turn.on('answered', hasCheck);
  turn.on('truncated', hasCheck);
  turn.on('empty', empty);
  repetition.on('ok', tools);
  repetition.on('tripped', circling);
  tools.on('done', conversation);
  tools.on('refused', conversation);
  tools.on('failing', failing);
  hasCheck.on('true', check);
  hasCheck.on('false', judge);
  check.on('ok', judge);
  check.on('failed', judge);
  judge.on('ok', verdict);
  judge.on('failed', unjudged);
  verdict.on('yes', record);
  verdict.on('no', rejected);
  verdict.on('unsure', rejected);
  record.on('ok', finished);
  record.on('failed', notRecorded);
  rejected.on('ok', didNotPass);
  rejected.on('failed', notRecorded);
  unjudged.on('ok', couldNotJudge);
  unjudged.on('failed', notRecorded);
  release.on('done', released);

  p.layout({
    provision: [0, 0],
    input: [0, 280],
    persona: [0, 420],
    claim: [260, 0],
    conversation: [520, 0],
    turn: [780, 0],
    repetition: [1040, 0],
    tools: [1300, 0],
    hasCheck: [1040, 280],
    check: [1300, 280],
    evidence: [1300, 420],
    judge: [1560, 280],
    model: [1560, 560],
    verdict: [1820, 280],
    record: [2080, 280],
    rejected: [2080, 420],
    unjudged: [1820, 560],
    finished: [2340, 280],
    didNotPass: [2340, 420],
    couldNotJudge: [2080, 560],
    notRecorded: [2340, 700],
    notClaimed: [260, 140],
    empty: [1040, 420],
    circling: [1300, 140],
    failing: [1560, 140],
    unavailable: [260, 420],
    release: [0, 700],
    released: [260, 700],
  });
});

export const DELIVERY_V2 = defineProcedure(BUILT_IN_GROUPS, {
  id: 'delivery',
  version: '2',
  name: 'Delivery',
  describe: 'Has the planner break a goal into tasks, shows a person the plan to accept, then hands every ready task to an executor, a few at a time, until nothing is ready. Fails, listing which tasks and why, if any of the work failed.',
  budget: {},
}, (p) => {
  const input = p.runInput('input');
  const persona = p.persona('persona');
  const plan = p.delegate('plan', { values: input.inputs }, { agent: 'planner', inputs: '{"goal":"{{values.goal}}"}' });
  const review = p.waitForPerson('review', { details: plan.text }, {
    prompt: 'Here is the proposed work. Accept what you want on the task board, then reply to carry on.',
  });
  const gather = p.callTool('gather', { persona: persona.persona }, { tool: 'list_tasks', args: '{"ready":true}' });
  const anyReady = p.condition('anyReady', { value: gather.result }, { expression: 'not empty(value)' });
  const work = p.fanOut('work', { items: gather.result }, { agent: 'executor', maxParallel: 3 });
  const outcomes = p.collect('outcomes', { item: work.children }, { spread: true });
  const failures = p.merge('failures', { children: work.children }, { strategy: 'failed' });
  const failed = p.collect('failed', { item: failures.merged }, { spread: true });
  const anyFailed = p.condition('anyFailed', { value: failed.items }, { expression: 'not empty(value)' });
  const settled = p.finish('settled', { result: outcomes.items }, { outcome: 'ok', reason: 'every task that was ready was done' });
  const someFailed = p.finish('someFailed', { result: failed.items }, {
    outcome: 'failed',
    reason: 'some of the work failed — the result lists which tasks and why',
  });
  const planFailed = p.finish('planFailed', { reason: plan.reason }, { outcome: 'failed' });
  const notAccepted = p.finish('notAccepted', { reason: review.reason }, { outcome: 'failed' });
  const cannotList = p.finish('cannotList', { reason: gather.text }, { outcome: 'failed' });

  p.start(plan);
  plan.on('ok', review);
  plan.on('failed', planFailed);
  review.on('answered', gather);
  review.on('unanswered', notAccepted);
  gather.on('ok', anyReady);
  gather.on('failed', cannotList);
  anyReady.on('true', work);
  anyReady.on('false', anyFailed);
  anyFailed.on('true', someFailed);
  anyFailed.on('false', settled);
  work.on('done', outcomes);
  outcomes.on('done', failures);
  failures.on('done', failed);
  failed.on('done', gather);

  p.layout({
    input: [0, 140],
    persona: [520, 280],
    plan: [260, 0],
    review: [520, 0],
    gather: [780, 0],
    anyReady: [1040, 0],
    work: [1300, 0],
    outcomes: [1560, 0],
    failures: [1820, 0],
    failed: [2080, 0],
    anyFailed: [1300, 140],
    settled: [1560, 140],
    someFailed: [1560, 280],
    planFailed: [260, 140],
    notAccepted: [520, 140],
    cannotList: [780, 140],
  });
});

export const BUILT_IN_PROCEDURES: readonly Procedure[] = [
  TOOL_ROUNDS_V2,
  INTERACTIVE_CHAT_V3,
  PLANNING_V2,
  RESEARCH_V2,
  SINGLE_SHOT_V2,
  DO_ONE_TASK_V2,
  DELIVERY_V2,
];
