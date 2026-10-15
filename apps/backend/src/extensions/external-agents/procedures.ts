import { BUILT_IN_GROUPS, defineProcedure, type Procedure } from '@koala/agent-engine/procedure';

export const EXTERNAL_AGENT_TASK: Procedure = defineProcedure(BUILT_IN_GROUPS, {
  id: 'external-agent-task',
  name: 'Hand a task to an agent on the machine',
  describe: 'The run\'s task, handed to the agent of the same name on the person\'s machine, in the project\'s folder there: it is told this agent\'s prompt and what was learned before once, when its session starts, then given the task. Whatever it wants permission for waits for the person. It ends with what the agent said.',
  version: '1',
  budget: {},
}, (p) => {
  const input = p.runInput('input');
  const persona = p.persona('persona');
  const memories = p.recallMemory('memories');
  const provision = p.provisionSandbox('provision');
  const agent = p.externalAgent('agent', { brief: input.message, prompt: persona.prompt, memories: memories.text, environment: provision.environment });
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
    input: [0, 0], persona: [0, 140], memories: [0, 280],
    provision: [260, 0], unavailable: [260, 200],
    agent: [520, 0], done: [780, -120], stopped: [780, 40], failed: [780, 200],
  });
});
