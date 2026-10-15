import { BUILT_IN_GROUPS, builtInCatalogue, defineProcedure, type Procedure } from '@koala/agent-engine/procedure';
import { CUT_OVER, DECISION_NODE, DISCARD, RELEASE_PROCEDURE, REPLACE_PROCEDURE, RETEST, ROLL_BACK_PROCEDURE } from '../../lib/release-run.js';
import { RELEASE_OPERATIONS } from './operations/declarations.js';

function out<T extends { readonly [socket: string]: unknown }>(node: T, socket: string): NonNullable<T[string]> {
  const found = node[socket];
  if (found === undefined) throw new Error(`a release procedure wires "${socket}", which that operation does not have`);
  return found as NonNullable<T[string]>;
}

const CATALOGUE = builtInCatalogue(RELEASE_OPERATIONS);
const op = (operation: string, settings: Record<string, unknown> = {}) => ({ operation, ...settings });

export const SLOTS: Procedure = defineProcedure(BUILT_IN_GROUPS, {
  id: RELEASE_PROCEDURE,
  name: 'Release beside the live slot',
  describe: 'A build released the A/B way. The first release goes into slot a. Every later one is prepared in the idle slot from a copy of the live data, upgraded, quieted and started on its preview address; its browser tests run, and the person cuts it over, discards it or runs the tests again. Cutting over puts the live slot in maintenance, copies and upgrades once more, switches live and stops the old slot, which keeps its data as the way back. A newer build stops a waiting preview, which is cleared and set aside.',
  version: '1',
  budget: {},
}, (p) => {
  const open = p.hostOp('open', {}, op('releases.open'));
  const gone = p.finish('gone', { reason: out(open, 'reason') }, { outcome: 'failed' });

  const installFirst = p.hostOp('installFirst', { release: out(open, 'release') }, op('releases.install-first'));
  const firstLive = p.hostOp('firstLive', { release: out(installFirst, 'release') }, op('releases.mark', { state: 'live' }));
  const firstDone = p.finish('firstDone', {}, { outcome: 'ok', reason: 'the first release is live in slot a' });
  const firstFailed = p.hostOp('firstFailed', { release: out(open, 'release'), reason: out(installFirst, 'reason') }, op('releases.mark', { state: 'failed' }));
  const firstBroke = p.finish('firstBroke', { reason: out(installFirst, 'reason') }, { outcome: 'failed' });

  const prepare = p.hostOp('prepare', { release: out(open, 'release') }, op('releases.prepare'));
  const prepareFailed = p.hostOp('prepareFailed', { release: out(open, 'release'), reason: out(prepare, 'reason') }, op('releases.mark', { state: 'failed' }));
  const prepareBroke = p.finish('prepareBroke', { reason: out(prepare, 'reason') }, { outcome: 'failed' });
  const tests = p.hostOp('tests', { release: out(prepare, 'release') }, op('releases.browser-tests'));
  const decide = p.waitForPerson(DECISION_NODE, {}, {
    prompt: 'The build is ready on its preview address, and its browser tests have run. Cut it over, discard it, or run its tests again?',
    choices: [CUT_OVER, DISCARD, RETEST],
  });
  const unanswered = p.finish('unanswered', { reason: decide.reason }, { outcome: 'failed' });
  const cutOver = p.condition('cutOver', { value: decide.answer }, { expression: `value == '${CUT_OVER}'` });
  const discard = p.condition('discard', { value: decide.answer }, { expression: `value == '${DISCARD}'` });

  const cutting = p.hostOp('cutting', { release: out(prepare, 'release') }, op('releases.mark', { state: 'cutting-over' }));
  const switchSlots = p.hostOp('switch', { release: out(prepare, 'release') }, op('releases.switch'));
  const live = p.hostOp('live', { release: out(switchSlots, 'release') }, op('releases.mark', { state: 'live' }));
  const cutDone = p.finish('cutDone', {}, { outcome: 'ok', reason: 'the release is live' });
  const switchFailed = p.hostOp('switchFailed', { release: out(prepare, 'release'), reason: out(switchSlots, 'reason') }, op('releases.mark', { state: 'failed' }));
  const switchBroke = p.finish('switchBroke', { reason: out(switchSlots, 'reason') }, { outcome: 'failed' });

  const clear = p.hostOp('clear', { release: out(prepare, 'release') }, op('releases.clear'));
  const discarded = p.hostOp('discarded', { release: out(prepare, 'release') }, op('releases.mark', { state: 'discarded' }));
  const discardDone = p.finish('discardDone', {}, { outcome: 'ok', reason: 'the person discarded the preview' });
  const clearFailed = p.hostOp('clearFailed', { release: out(prepare, 'release'), reason: out(clear, 'reason') }, op('releases.mark', { state: 'failed' }));
  const clearBroke = p.finish('clearBroke', { reason: out(clear, 'reason') }, { outcome: 'failed' });

  const stopped = p.hostOp('stopped', {}, op('releases.stopped'));
  const settled = p.finish('settled', {}, { outcome: 'ok' });

  p.start(open);
  p.cleanup(stopped);
  open.on('gone', gone);
  open.on('first', installFirst);
  open.on('beside', prepare);
  installFirst.on('done', firstLive);
  installFirst.on('failed', firstFailed);
  firstLive.on('done', firstDone);
  firstFailed.on('done', firstBroke);
  prepare.on('ready', tests);
  prepare.on('failed', prepareFailed);
  prepareFailed.on('done', prepareBroke);
  tests.on('done', decide);
  decide.on('answered', cutOver);
  decide.on('unanswered', unanswered);
  cutOver.on('true', cutting);
  cutOver.on('false', discard);
  discard.on('true', clear);
  discard.on('false', tests);
  cutting.on('done', switchSlots);
  switchSlots.on('done', live);
  switchSlots.on('failed', switchFailed);
  live.on('done', cutDone);
  switchFailed.on('done', switchBroke);
  clear.on('done', discarded);
  clear.on('failed', clearFailed);
  discarded.on('done', discardDone);
  clearFailed.on('done', clearBroke);
  stopped.on('done', settled);
  p.layout({
    open: [0, 0], gone: [0, 200],
    installFirst: [260, -320], firstLive: [520, -320], firstDone: [780, -320], firstFailed: [520, -200], firstBroke: [780, -200],
    prepare: [260, 0], prepareFailed: [260, 160], prepareBroke: [260, 280],
    tests: [520, 0], decide: [780, 0], unanswered: [780, 160],
    cutOver: [1040, 0], cutting: [1300, -120], switch: [1560, -120], live: [1820, -120], cutDone: [2080, -120],
    switchFailed: [1820, 20], switchBroke: [2080, 20],
    discard: [1300, 160], clear: [1560, 160], discarded: [1820, 160], discardDone: [2080, 160], clearFailed: [1820, 300], clearBroke: [2080, 300],
    stopped: [0, 440], settled: [260, 440],
  });
}, CATALOGUE);

export const SLOTS_ROLL_BACK: Procedure = defineProcedure(BUILT_IN_GROUPS, {
  id: ROLL_BACK_PROCEDURE,
  name: 'Roll back to the kept slot',
  describe: 'Goes back to the release kept at the last cut-over: its slot is started, waited for, and made live, and the current one is stopped. The app returns to how it was at that cut-over; anything entered since is lost.',
  version: '1',
  budget: {},
}, (p) => {
  const rollBack = p.hostOp('rollBack', {}, op('releases.roll-back'));
  const done = p.finish('done', {}, { outcome: 'ok', reason: 'the kept release is live again' });
  const broke = p.finish('broke', { reason: out(rollBack, 'reason') }, { outcome: 'failed' });
  p.start(rollBack);
  rollBack.on('done', done);
  rollBack.on('failed', broke);
  p.layout({ rollBack: [0, 0], done: [260, -80], broke: [260, 80] });
}, CATALOGUE);

export const REPLACE: Procedure = defineProcedure(BUILT_IN_GROUPS, {
  id: REPLACE_PROCEDURE,
  name: 'Replace the running app',
  describe: 'A build released by replacing the app that runs: its image is deployed and the release ends when the app answers, or fails with why it never will. There is no preview to look at first.',
  version: '1',
  budget: {},
}, (p) => {
  const deploy = p.hostOp('deploy', {}, op('releases.deploy-image'));
  const done = p.finish('done', {}, { outcome: 'ok', reason: 'the build is deployed' });
  const broke = p.finish('broke', { reason: out(deploy, 'reason') }, { outcome: 'failed' });
  p.start(deploy);
  deploy.on('done', done);
  deploy.on('failed', broke);
  p.layout({ deploy: [0, 0], done: [260, -80], broke: [260, 80] });
}, CATALOGUE);
