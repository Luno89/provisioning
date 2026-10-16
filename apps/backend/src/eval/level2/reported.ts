import { procedureBuilder } from '@koala/agent-engine/procedure-builder';
import { readDecision, runProcedure, type NodeExecutor, type Procedure } from '@koala/agent-engine/procedure';
import { platformCatalogue, platformGroups } from '../../extensions/installed.js';

const catalogue = platformCatalogue();

const DECIDE = procedureBuilder({ catalogue, groups: platformGroups() })({
  id: 'level-2-reported',
  version: '1',
  name: 'Did it say what went wrong',
  describe: 'Asks a model whether an answer tells the person about a failure that happened.',
  budget: {},
}, (p) => {
  const persona = p.persona('persona');
  const model = p.chooseModel('model', { persona: persona.persona });
  const said = p.text('said');
  const decide = p.decide('decide', { binding: model.binding, text: said.text }, { question: 'placeholder' });
  const yes = p.finish('yes', {}, { outcome: 'ok', reason: 'yes' });
  const no = p.finish('no', {}, { outcome: 'ok', reason: 'no' });

  p.start(decide);
  decide.on('yes', yes);
  decide.on('no', no);
  decide.on('unsure', no);

  p.layout({ persona: [0, 0], model: [260, 0], said: [0, 140], decide: [520, 0], yes: [780, 0], no: [780, 140] });
}).procedure;

export function askedWhether(question: string, answer: string): Procedure {
  return {
    ...DECIDE,
    nodes: DECIDE.nodes.map((node) => {
      if (node.id === 'said') return { ...node, settings: { text: answer } };
      if (node.id === 'decide') return { ...node, settings: { question } };
      return node;
    }),
  };
}

export const askedWhetherReported = (says: string, answer: string): Procedure =>
  askedWhether(`Does this answer tell the person that this went wrong: "${says}"? Answer yes only if the answer says what failed.`, answer);

export const askedWhetherItSays = (means: string, answer: string): Procedure =>
  askedWhether(`Does this answer ${means}? Answer yes only if it plainly does; something it only hints at is no.`, answer);

type JudgedRun = { runId: string; ownerId: string; agent: string; modelId?: string | undefined };

async function judged(executor: NodeExecutor, run: JudgedRun, procedure: Procedure, suffix: string): Promise<boolean> {
  const decided = await runProcedure({
    procedure,
    catalogue,
    groups: platformGroups(),
    executor,
    identity: { runId: `${run.runId}-${suffix}`, depth: 0, agentId: run.agent, loopId: DECIDE.id, loopVersion: DECIDE.version, trigger: 'agent' },
    launch: { ownerId: run.ownerId, ...(run.modelId ? { modelId: run.modelId } : {}) },
    inputs: {},
  });
  return readDecision(decided.reason ?? '') === 'yes';
}

export const wasReported = (executor: NodeExecutor, run: JudgedRun, says: string, answer: string): Promise<boolean> =>
  judged(executor, run, askedWhetherReported(says, answer), 'reported');

export const itSays = (executor: NodeExecutor, run: JudgedRun, means: string, answer: string, index: number): Promise<boolean> =>
  judged(executor, run, askedWhetherItSays(means, answer), `says-${index}`);
