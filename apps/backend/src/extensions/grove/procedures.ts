import { BUILT_IN_GROUPS, builtInCatalogue, defineProcedure, type Procedure } from '@koala/agent-engine/procedure';
import { GROVE_OPERATIONS } from './operations/declarations.js';

function out<T extends { readonly [socket: string]: unknown }>(node: T, socket: string): NonNullable<T[string]> {
  const found = node[socket];
  if (found === undefined) throw new Error(`a grove procedure wires "${socket}", which that operation does not have`);
  return found as NonNullable<T[string]>;
}

const GROVE_CATALOGUE = builtInCatalogue(GROVE_OPERATIONS);

const op = (operation: string, settings: Record<string, unknown> = {}) => ({ operation, ...settings });

function leafProcedure(meta: { id: string; name: string; describe: string }, work: 'tasks' | 'writer'): Procedure {
  return defineProcedure(BUILT_IN_GROUPS, { ...meta, version: '1', budget: {} }, (p) => {
    const input = p.runInput('input');
    const provision = p.provisionSandbox('provision');
    const start = p.hostOp('start', { leaf: input.inputs }, op('grove.start-leaf'));
    const claim = p.hostOp('claim', { leaf: input.inputs, environment: provision.environment }, op('grove.file-claim', { result: 'claimed' }));
    const fail = p.hostOp('fail', { leaf: input.inputs, environment: provision.environment }, op('grove.file-claim', { result: 'failed' }));
    const filed = p.finish('filed', { result: out(claim, 'claim') }, { outcome: 'ok', reason: 'the leaf is claimed for its judge' });
    const failedFiled = p.finish('failedFiled', { result: out(fail, 'claim') }, { outcome: 'failed', reason: 'the leaf is claimed as failed' });
    const refused = p.finish('refused', { reason: out(claim, 'reason') }, { outcome: 'failed' });
    const failRefused = p.finish('failRefused', { reason: out(fail, 'reason') }, { outcome: 'failed' });
    const notWaiting = p.finish('notWaiting', {}, { outcome: 'ok', reason: 'the leaf was no longer waiting to be worked' });
    const unavailable = p.finish('unavailable', { reason: provision.reason }, { outcome: 'failed' });
    const putBack = p.hostOp('putBack', { leaf: input.inputs }, op('grove.return-leaf'));
    const cleaned = p.finish('cleaned', {}, { outcome: 'ok' });

    p.start(provision);
    p.cleanup(putBack);
    provision.on('ready', start);
    provision.on('unavailable', unavailable);
    start.on('notWaiting', notWaiting);
    claim.on('filed', filed);
    claim.on('refused', refused);
    fail.on('filed', failedFiled);
    fail.on('refused', failRefused);
    putBack.on('done', cleaned);

    if (work === 'tasks') {
      const next = p.hostOp('next', { leaf: input.inputs }, op('grove.next-task'));
      const task = p.delegate('task', { values: out(next, 'task'), environment: provision.environment }, {
        agent: 'executor',
        inputs: '{"item":"{{values}}","message":"Work the task {{values.title}}."}',
      });
      const back = p.hostOp('back', { leaf: input.inputs }, op('grove.return-leaf'));
      const returned = p.finish('returned', {}, { outcome: 'ok', reason: 'the leaf has no tasks yet, so it waits for the planner' });
      fail.wire({ reason: out(next, 'reason') });
      start.on('started', next);
      next.on('run', task);
      next.on('claim', claim);
      next.on('fail', fail);
      next.on('unbroken', back);
      task.on('ok', next);
      task.on('failed', next);
      back.on('done', returned);
      p.layout({
        input: [0, 0], provision: [260, 0], start: [520, 0], next: [780, 0], task: [1040, 0],
        claim: [1040, 160], fail: [1040, 320], back: [1040, 480],
        filed: [1300, 160], refused: [1300, 240], failedFiled: [1300, 320], failRefused: [1300, 400], returned: [1300, 480],
        notWaiting: [780, 160], unavailable: [520, 160], putBack: [0, 640], cleaned: [260, 640],
      });
    } else {
      const write = p.delegate('write', { values: input.inputs, environment: provision.environment }, {
        agent: 'paper-writer',
        inputs: '{"leafId":"{{values.item.leafId}}","leafTitle":"{{values.item.title}}","leafBody":"{{values.item.body}}","message":"Work the leaf \\"{{values.item.title}}\\"."}',
      });
      claim.wire({ evidence: write.text });
      fail.wire({ reason: write.reason });
      start.on('started', write);
      write.on('ok', claim);
      write.on('failed', fail);
      p.layout({
        input: [0, 0], provision: [260, 0], start: [520, 0], write: [780, 0],
        claim: [1040, 0], fail: [1040, 160], filed: [1300, 0], refused: [1300, 80], failedFiled: [1300, 160], failRefused: [1300, 240],
        notWaiting: [780, 160], unavailable: [520, 160], putBack: [0, 400], cleaned: [260, 400],
      });
    }
  }, GROVE_CATALOGUE);
}

export const GROVE_LEAF = leafProcedure({
  id: 'grove-leaf',
  name: 'Grove leaf',
  describe: 'One leaf of a tree, worked task by task: start the leaf, ask what it needs next, hand each task to an executor in the leaf\'s worktree, and ask again — then file the claim for a judge, or file it failed with why, or put the leaf back for the planner when it has no tasks. A stopped run puts the leaf back to waiting.',
}, 'tasks');

export const GROVE_PAPER_LEAF = leafProcedure({
  id: 'grove-paper-leaf',
  name: 'Grove paper leaf',
  describe: 'One leaf of a research paper, written in one run: start the leaf, hand its goal to the paper writer in the leaf\'s worktree, and file the claim with what the writer said for itself — or file it failed with why.',
}, 'writer');

function runProcedure(meta: { id: string; name: string; describe: string }, leafAgent: string): Procedure {
  return defineProcedure(BUILT_IN_GROUPS, { ...meta, version: '1', budget: {} }, (p) => {
    const open = p.hostOp('open', {}, op('grove.open-tree'));
    const leaves = p.hostOp('leaves', { tree: out(open, 'tree') }, op('grove.leaves'));
    const prepareWork = p.hostOp('prepareWork', { environment: out(open, 'environment'), tree: out(open, 'tree'), leaves: out(leaves, 'ready') }, op('grove.prepare-worktrees'));
    const work = p.fanOut('work', { items: out(prepareWork, 'items'), environment: out(open, 'environment') }, { agent: leafAgent, maxParallel: 3 });
    const check = p.hostOp('check', { environment: out(open, 'environment'), tree: out(open, 'tree'), claimed: out(leaves, 'claimed') }, op('grove.check-claims'));
    const checkouts = p.hostOp('checkouts', { environment: out(open, 'environment'), tree: out(open, 'tree'), claims: out(check, 'toJudge') }, op('grove.judge-checkouts'));
    const judge = p.fanOut('judge', { items: out(checkouts, 'items'), environment: out(open, 'environment') }, { agent: 'leaf-judge', maxParallel: 3 });
    const judgeFailures = p.merge('judgeFailures', { children: judge.children }, { strategy: 'failed' });
    const judged = p.condition('judged', { value: judgeFailures.merged }, { expression: 'empty(value)' });
    const judgeBroke = p.finish('judgeBroke', { result: judgeFailures.merged }, { outcome: 'failed', reason: 'a judge could not settle its claim, so the run stops rather than judge it again every pass' });
    const needs = p.hostOp('needs', { tree: out(open, 'tree') }, op('grove.needs-plan'));
    const preparePlans = p.hostOp('preparePlans', { environment: out(open, 'environment'), tree: out(open, 'tree'), leaves: out(needs, 'items') }, op('grove.prepare-worktrees'));
    const plan = p.fanOut('plan', { items: out(preparePlans, 'items'), environment: out(open, 'environment') }, { agent: 'planner', maxParallel: 3, itemAsInputs: true });
    const proposals = p.hostOp('proposals', { tree: out(open, 'tree') }, op('grove.open-proposals'));
    const report = p.hostOp('report', { tree: out(open, 'tree'), awaitingReview: out(leaves, 'awaitingReview'), proposals: out(proposals, 'proposals') }, op('grove.report', { outcome: 'quiet' }));
    const quiet = p.finish('quiet', { result: out(report, 'result') }, { outcome: 'ok', reason: 'the tree is quiet' });
    const unavailable = p.finish('unavailable', { reason: out(open, 'reason') }, { outcome: 'failed' });
    const park = p.hostOp('park', { tree: out(open, 'tree') }, op('grove.park-tree'));
    const parked = p.finish('parked', {}, { outcome: 'ok' });

    p.start(open);
    p.cleanup(park);
    open.on('ready', leaves);
    open.on('unavailable', unavailable);
    leaves.on('work', prepareWork);
    leaves.on('judge', check);
    leaves.on('quiet', needs);
    prepareWork.on('ready', work);
    prepareWork.on('none', leaves);
    work.on('done', leaves);
    check.on('judge', checkouts);
    check.on('settled', leaves);
    checkouts.on('ready', judge);
    judge.on('done', judgeFailures);
    judgeFailures.on('done', judged);
    judged.on('true', leaves);
    judged.on('false', judgeBroke);
    needs.on('some', preparePlans);
    needs.on('none', proposals);
    preparePlans.on('ready', plan);
    preparePlans.on('none', proposals);
    plan.on('done', proposals);
    proposals.on('some', report);
    proposals.on('none', report);
    report.on('done', quiet);
    park.on('done', parked);
    p.layout({
      open: [0, 0], unavailable: [0, 160], leaves: [260, 0],
      prepareWork: [520, -160], work: [780, -160],
      check: [520, 0], checkouts: [780, 0], judge: [1040, 0], judgeFailures: [1300, 0], judged: [1560, 0], judgeBroke: [1820, 0],
      needs: [520, 160], preparePlans: [780, 160], plan: [1040, 160], proposals: [1300, 160], report: [1560, 160], quiet: [1820, 160],
      park: [0, 360], parked: [260, 360],
    });
  }, GROVE_CATALOGUE);
}

export const GROVE_RUN = runProcedure({
  id: 'grove-run',
  name: 'Grove run',
  describe: 'A tree grown until it is quiet: open the tree and its shared workspace, work every ready leaf in its own worktree, check each claim\'s own checks and judge the rest from the commit it points at, and when nothing is left to work or judge, plan the leaves that failed or have no tasks yet — then report what waits for a person. The workspace is parked however the run ends.',
}, 'grove-leaf');

export const GROVE_PAPER_RUN = runProcedure({
  id: 'grove-paper-run',
  name: 'Grove paper run',
  describe: 'A research-paper tree grown until it is quiet: the grove run, with each leaf written in one run by the paper writer rather than worked task by task.',
}, 'grove-paper-leaf');
