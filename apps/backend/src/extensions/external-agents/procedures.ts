import { BUILT_IN_GROUPS, defineProcedure, type Procedure } from '@koala/agent-engine/procedure';
import { EXTERNAL_CHAT_PROCEDURE, EXTERNAL_TASK_PROCEDURE } from '../../machines/lib/machine-runs.js';

export const EXTERNAL_AGENT_TASK: Procedure = defineProcedure(BUILT_IN_GROUPS, {
  id: EXTERNAL_TASK_PROCEDURE,
  name: 'Hand a task to an agent on the machine',
  describe: 'The run\'s task, handed to the agent of the same name on the person\'s machine, in the project\'s folder there: it is told this agent\'s prompt and what was learned before once, when its session starts, then given the task, with this agent\'s own tools served to it (each call runs here, as this agent\'s would). Whatever it wants permission for waits for the person. It ends with what the agent said.',
  version: '2',
  budget: {},
}, (p) => {
  const input = p.runInput('input');
  const persona = p.persona('persona');
  const memories = p.recallMemory('memories');
  const provision = p.provisionSandbox('provision');
  const tools = p.resolveTools('tools', { persona: persona.persona, delegates: persona.delegates, environment: provision.environment });
  const agent = p.externalAgent('agent', { brief: input.message, prompt: persona.prompt, memories: memories.text, environment: provision.environment, persona: persona.persona, tools: tools.offered });
  const done = p.finish('done', { result: agent.text }, { outcome: 'ok' });
  const stopped = p.finish('stopped', { reason: agent.reason }, { outcome: 'failed' });
  const failed = p.finish('failed', { reason: agent.reason }, { outcome: 'failed' });
  const unavailable = p.finish('unavailable', { reason: provision.reason }, { outcome: 'failed' });

  p.start(provision);
  provision.on('ready', agent);
  provision.on('unavailable', unavailable);
  agent.on('finished', done);
  agent.on('stopped', stopped);
  agent.on('failed', failed);
  p.layout({
    input: [0, 0], persona: [0, 140], memories: [0, 280], tools: [260, 140],
    provision: [260, 0], unavailable: [260, 200],
    agent: [520, 0], done: [780, -120], stopped: [780, 40], failed: [780, 200],
  });
});

export const EXTERNAL_AGENT_CHAT: Procedure = defineProcedure(BUILT_IN_GROUPS, {
  id: EXTERNAL_CHAT_PROCEDURE,
  name: 'A chat turn answered by an agent on the machine',
  describe: 'One turn of a conversation answered by an agent on the person\'s machine, picked where a model is picked, on the model picked for it. The conversation keeps one session with each agent, model and machine, so the next turn continues it; a new session is told this agent\'s prompt, what was learned before and what was said so far, once. This agent\'s own tools are served to it, and each call runs here as this agent\'s would. Whatever the agent wants permission for waits for the person. The turn is written back to the conversation.',
  version: '3',
  budget: {},
}, (p) => {
  const input = p.runInput('input');
  const persona = p.persona('persona');
  const memories = p.recallMemory('memories');
  const earlier = p.loadConversation('earlier', { values: input.inputs }, { id: '{{values.conversationId}}' });
  const provision = p.provisionSandbox('provision');
  const tools = p.resolveTools('tools', { persona: persona.persona, delegates: persona.delegates, environment: provision.environment });
  const agent = p.externalAgent('agent', {
    brief: input.message,
    prompt: persona.prompt,
    memories: memories.text,
    environment: provision.environment,
    sessions: earlier.sessions,
    conversation: earlier.messages,
    persona: persona.persona,
    tools: tools.offered,
  });
  const remember = p.saveConversation('remember', { values: input.inputs, asked: input.message, reply: agent.reply, results: agent.results, session: agent.session, history: earlier.history }, { id: '{{values.conversationId}}' });
  const rememberFailed = p.saveConversation('rememberFailed', { values: input.inputs, asked: input.message, reply: agent.reply, results: agent.results, session: agent.session, history: earlier.history, reason: agent.reason }, { id: '{{values.conversationId}}' });
  const done = p.finish('done', { result: agent.text }, { outcome: 'ok' });
  p.finish('stopped', { reason: agent.reason }, { outcome: 'failed' });
  const failed = p.finish('failed', { reason: agent.reason }, { outcome: 'failed' });
  const unavailable = p.finish('unavailable', { reason: provision.reason }, { outcome: 'failed' });
  const unsaved = p.finish('unsaved', {}, { outcome: 'failed', reason: 'the turn could not be written to the conversation' });

  p.start(provision);
  provision.on('ready', agent);
  provision.on('unavailable', unavailable);
  agent.on('finished', remember);
  agent.on('stopped', rememberFailed);
  agent.on('failed', rememberFailed);
  remember.on('saved', done);
  remember.on('failed', unsaved);
  rememberFailed.on('saved', failed);
  rememberFailed.on('failed', unsaved);
  p.layout({
    input: [0, 0], persona: [0, 140], memories: [0, 280], earlier: [0, 420], tools: [260, 280],
    provision: [260, 0], unavailable: [260, 200],
    agent: [520, 0], remember: [780, -120], rememberFailed: [780, 80],
    done: [1040, -120], failed: [1040, 80], unsaved: [1040, 240], stopped: [1040, 360],
  });
});
