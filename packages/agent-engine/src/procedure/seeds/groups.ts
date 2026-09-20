import type { GroupDefinition } from '../schema.js';
import { defineGroup } from './define.js';

export const MODEL_TURN = defineGroup('model-turn', {
  title: 'Model Turn',
  describe: 'One call to the model with everything it needs: the persona\'s prompt, where it is working, the tools it can and cannot use, what it remembers, and what its answer must contain — fitted to the context window.',
  inputs: {
    messages: { type: 'messages', describe: 'The conversation to send.', required: true },
    environment: { type: 'environment', describe: 'Where the run is working. Nothing wired means no environment.' },
  },
  outputs: {
    reply: { type: 'reply', describe: 'The model\'s reply.' },
    content: { type: 'text', describe: 'Just what the model said.' },
    persona: { type: 'persona', describe: 'The persona the turn was for.' },
    binding: { type: 'modelBinding', describe: 'The model that was called.' },
    system: { type: 'text', describe: 'The system prompt that was sent.' },
  },
  exits: {
    toolCalls: { describe: 'The model asked for tools.' },
    answered: { describe: 'The model replied without asking for tools.' },
    truncated: { describe: 'The reply was cut off by the token cap.' },
    empty: { describe: 'The model said and asked for nothing.' },
  },
}, (g) => {
  const persona = g.persona('persona');
  const model = g.chooseModel('model', { persona: persona.persona });
  const tools = g.resolveTools('tools', { persona: persona.persona, delegates: persona.delegates, environment: g.inputs.environment });
  const environment = g.describeEnvironment('environment', { environment: g.inputs.environment, delegates: persona.delegates });
  const around = g.describeProcedure('around');
  const toolText = g.describeTools('toolText', { offered: tools.offered, withheld: tools.withheld, environment: g.inputs.environment });
  const memory = g.recallMemory('memory');
  const outputs = g.describeOutputs('outputs', { persona: persona.persona });
  const context = g.buildContext('context', { sections: [persona.prompt, environment.text, around.text, toolText.text, memory.text, outputs.text] });
  const fit = g.fitReplyBudget('fit', { binding: model.binding, system: context.text, messages: g.inputs.messages });
  const call = g.callModel('call', {
    binding: model.binding,
    system: context.text,
    messages: g.inputs.messages,
    tools: tools.offered,
    maxTokens: fit.maxTokens,
  });

  g.start(call);
  call.on('toolCalls', g.exits.toolCalls);
  call.on('answered', g.exits.answered);
  call.on('truncated', g.exits.truncated);
  call.on('empty', g.exits.empty);
  g.output('reply', call.reply);
  g.output('content', call.content);
  g.output('persona', persona.persona);
  g.output('binding', model.binding);
  g.output('system', context.text);

  g.layout({
    persona: [0, 0],
    model: [260, 0],
    tools: [260, 140],
    environment: [260, 280],
    around: [520, 280],
    toolText: [520, 140],
    memory: [260, 420],
    outputs: [260, 560],
    context: [780, 280],
    fit: [1040, 140],
    call: [1300, 140],
  });
});

export const TOOL_LOOP = defineGroup('tool-loop', {
  title: 'Tool Loop',
  describe: 'Asks for approval where it is needed, runs the tools a reply asked for, trims what comes back to fit the context, and stops the run when calls keep failing.',
  inputs: {
    reply: { type: 'reply', describe: 'The reply whose tool calls to run.', required: true },
    persona: { type: 'persona', describe: 'Whose grants and delegates decide what may run.', required: true },
    environment: { type: 'environment', describe: 'Where environment tools run.' },
  },
  outputs: {
    results: { type: 'toolResults', describe: 'The results of the calls that ran, trimmed.' },
    refused: { type: 'toolResults', describe: 'A result for each call that was refused.' },
    reason: { type: 'text', describe: 'Why it stopped, when it did.' },
  },
  exits: {
    done: { describe: 'The tools ran.' },
    refused: { describe: 'Every call was refused, so nothing ran.' },
    failing: { describe: 'Tool calls kept failing.' },
  },
}, (g) => {
  const approve = g.approveToolCalls('approve', { reply: g.inputs.reply, environment: g.inputs.environment });
  const run = g.runToolCalls('run', { reply: approve.approved, persona: g.inputs.persona, environment: g.inputs.environment });
  const trim = g.trimToolResults('trim', { results: run.results });
  const failures = g.checkToolFailures('failures', { results: trim.results });

  g.start(approve);
  approve.on('approved', run);
  run.on('done', failures);
  failures.on('ok', g.exits.done);
  approve.on('refused', g.exits.refused);
  failures.on('tripped', g.exits.failing);
  g.output('results', trim.results);
  g.output('refused', approve.refused);
  g.output('reason', failures.reason);

  g.layout({
    approve: [0, 0],
    run: [260, 0],
    trim: [520, 140],
    failures: [780, 0],
  });
});

export const BUILT_IN_GROUPS: readonly GroupDefinition[] = [MODEL_TURN, TOOL_LOOP];
