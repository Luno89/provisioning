import { BUILT_IN_GROUPS, builtInCatalogue, defineProcedure, type Procedure } from '@koala/agent-engine/procedure';
import { PROVISION_PIECES } from '@koala/engine-core/koala-install';
import { PROVISION_OPERATIONS } from './operations/declarations.js';
import { PROVISION_PROCEDURE } from './names.js';

function out<T extends { readonly [socket: string]: unknown }>(node: T, socket: string): NonNullable<T[string]> {
  const found = node[socket];
  if (found === undefined) throw new Error(`the provision procedure wires "${socket}", which that operation does not have`);
  return found as NonNullable<T[string]>;
}

const CATALOGUE = builtInCatalogue(PROVISION_OPERATIONS);
const op = (operation: string, settings: Record<string, unknown> = {}) => ({ operation, ...settings });

export const PROVISION: Procedure = defineProcedure(BUILT_IN_GROUPS, {
  id: PROVISION_PROCEDURE,
  name: 'Set Koala up',
  describe: 'Sets up what a Koala needs after its chart: on the Koala\'s own cluster the egress proxy, SearXNG, Crawl4AI, Quickwit, Qdrant, TEI, Gitea, the npm registry mirror, Infisical and monitoring, all at once, since none needs another; on another of the person\'s machines only the collector that sends its metrics, logs and traces to the Koala. Each piece applies only what is missing and waits until it is up. The setup is up once every piece is. A piece that can never come up stops none of the others; once every piece has ended, the setup ends failed naming each piece that did not come up and why. Setting Koala up again sets up only the pieces that are not up.',
  version: '4',
  budget: {},
}, (p) => {
  const open = p.hostOp('open', {}, op('provision.open'));
  const openBroke = p.finish('openBroke', { reason: out(open, 'reason') }, { outcome: 'failed' });
  const machine = p.condition('machine', { value: out(open, 'kind') }, { expression: 'value == \'machine\'' });
  const collector = p.hostOp('collector', {}, op('provision.monitoring'));
  const collectorFailed = p.hostOp('collectorFailed', { reason: out(collector, 'reason') }, op('provision.mark', { state: 'failed' }));
  const collectorBroke = p.finish('collectorBroke', { reason: out(collector, 'reason') }, { outcome: 'failed' });
  for (const piece of PROVISION_PIECES) {
    p.hostOp(piece.key, {}, piece.key === 'monitoring' ? op('provision.monitoring') : op('provision.service', { service: piece.key }), { label: piece.title });
  }
  const pieces = p.together('pieces', {}, { branches: PROVISION_PIECES.map((piece) => ({ node: piece.key })) });
  const piecesFailed = p.hostOp('piecesFailed', { reason: pieces.reason }, op('provision.mark', { state: 'failed' }));
  const piecesBroke = p.finish('piecesBroke', { reason: pieces.reason }, { outcome: 'failed' });
  const markUp = p.hostOp('markUp', {}, op('provision.mark', { state: 'up' }));
  const upDone = p.finish('upDone', {}, { outcome: 'ok', reason: 'Koala is set up' });
  const upFailed = p.hostOp('upFailed', { reason: out(markUp, 'reason') }, op('provision.mark', { state: 'failed' }));
  const upBroke = p.finish('upBroke', { reason: out(markUp, 'reason') }, { outcome: 'failed' });

  p.start(open);
  open.on('done', machine);
  open.on('failed', openBroke);
  machine.on('true', collector);
  machine.on('false', pieces);
  collector.on('done', markUp);
  collector.on('failed', collectorFailed);
  collectorFailed.on('done', collectorBroke);
  collectorFailed.on('failed', collectorBroke);
  pieces.on('done', markUp);
  pieces.on('failed', piecesFailed);
  piecesFailed.on('done', piecesBroke);
  piecesFailed.on('failed', piecesBroke);
  markUp.on('done', upDone);
  markUp.on('failed', upFailed);
  upFailed.on('done', upBroke);
  upFailed.on('failed', upBroke);

  const layout: Record<string, [number, number]> = {
    open: [0, 0], openBroke: [0, 200], machine: [260, 0],
    collector: [520, -200], collectorFailed: [780, -200], collectorBroke: [1040, -200],
    pieces: [520, 0], piecesFailed: [780, 160], piecesBroke: [780, 280],
    markUp: [1040, 0], upDone: [1300, 0], upFailed: [1040, 160], upBroke: [1040, 280],
  };
  PROVISION_PIECES.forEach((piece, at) => { layout[piece.key] = [520 + at * 220, 440]; });
  p.layout(layout);
}, CATALOGUE);
