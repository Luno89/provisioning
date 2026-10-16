import { BUILT_IN_GROUPS, builtInCatalogue, defineProcedure, type Procedure } from '@koala/agent-engine/procedure';
import { CUT_OVER, CUT_OVER_LOSING, DECISION_NODE, DISCARD, LOSING_DECISION_NODE, RELEASE_PROCEDURE, REPLACE_PROCEDURE, RETEST, ROLL_BACK_PROCEDURE } from '../../lib/release-run.js';
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
  describe: 'A build released the A/B way. The first release goes into slot a. Every later one is prepared in the idle slot from a copy of the live data, upgraded, quieted and started on its preview address, then compared with live: what the upgrade drops, what changes type, and what made or changed in the app it keeps, resets, switches off or loses. Its browser tests run, and the person cuts it over, discards it or runs the tests again; when it would lose something, cutting over means confirming the loss. Cutting over puts the live slot in maintenance, copies and upgrades once more, compares again and stops if anything new would be lost, then switches live and stops the old slot, which keeps its data as the way back. A newer build stops a waiting preview, which is cleared and set aside.',
  version: '2',
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
  const compare = p.hostOp('compare', { release: out(prepare, 'release') }, op('releases.compare'));
  const compareClear = p.hostOp('compareClear', { release: out(prepare, 'release') }, op('releases.clear'));
  const compareFailed = p.hostOp('compareFailed', { release: out(prepare, 'release'), reason: out(compare, 'reason') }, op('releases.mark', { state: 'failed' }));
  const compareBroke = p.finish('compareBroke', { reason: out(compare, 'reason') }, { outcome: 'failed' });
  const tests = p.hostOp('tests', { release: out(compare, 'release') }, op('releases.browser-tests'));
  const losing = p.condition('losing', { value: out(compare, 'losing') }, { expression: 'value == true' });
  const decide = p.waitForPerson(DECISION_NODE, {}, {
    prompt: 'The build is ready on its preview address, and its browser tests have run. Cut it over, discard it, or run its tests again?',
    choices: [CUT_OVER, DISCARD, RETEST],
  });
  const unanswered = p.finish('unanswered', { reason: decide.reason }, { outcome: 'failed' });
  const cutOver = p.condition('cutOver', { value: decide.answer }, { expression: `value == '${CUT_OVER}'` });
  const discard = p.condition('discard', { value: decide.answer }, { expression: `value == '${DISCARD}'` });
  const decideLosing = p.waitForPerson(LOSING_DECISION_NODE, {}, {
    prompt: 'The build is ready on its preview address and its browser tests have run, but cutting it over would lose what its release lists. Cut it over anyway, losing that, discard it, or run its tests again?',
    choices: [CUT_OVER_LOSING, DISCARD, RETEST],
  });
  const unansweredLosing = p.finish('unansweredLosing', { reason: decideLosing.reason }, { outcome: 'failed' });
  const cutOverLosing = p.condition('cutOverLosing', { value: decideLosing.answer }, { expression: `value == '${CUT_OVER_LOSING}'` });
  const discardLosing = p.condition('discardLosing', { value: decideLosing.answer }, { expression: `value == '${DISCARD}'` });

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
  prepare.on('ready', compare);
  prepare.on('failed', prepareFailed);
  prepareFailed.on('done', prepareBroke);
  compare.on('done', tests);
  compare.on('failed', compareClear);
  compareClear.on('done', compareFailed);
  compareClear.on('failed', compareFailed);
  compareFailed.on('done', compareBroke);
  tests.on('done', losing);
  losing.on('true', decideLosing);
  losing.on('false', decide);
  decide.on('answered', cutOver);
  decide.on('unanswered', unanswered);
  cutOver.on('true', cutting);
  cutOver.on('false', discard);
  discard.on('true', clear);
  discard.on('false', tests);
  decideLosing.on('answered', cutOverLosing);
  decideLosing.on('unanswered', unansweredLosing);
  cutOverLosing.on('true', cutting);
  cutOverLosing.on('false', discardLosing);
  discardLosing.on('true', clear);
  discardLosing.on('false', tests);
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
    compare: [520, 0], compareClear: [520, 160], compareFailed: [520, 280], compareBroke: [520, 400],
    tests: [780, 0], losing: [1040, 0], decide: [1300, -160], unanswered: [1300, -300],
    decideLosing: [1300, 160], unansweredLosing: [1300, 300],
    cutOver: [1560, -160], cutOverLosing: [1560, 160], cutting: [1820, -160], switch: [2080, -160], live: [2340, -160], cutDone: [2600, -160],
    switchFailed: [2340, -20], switchBroke: [2600, -20],
    discard: [1820, 20], discardLosing: [1820, 300], clear: [2080, 160], discarded: [2340, 160], discardDone: [2600, 160], clearFailed: [2340, 300], clearBroke: [2600, 300],
    stopped: [0, 560], settled: [260, 560],
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
