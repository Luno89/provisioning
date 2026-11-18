import { BUILT_IN_GROUPS, builtInCatalogue, defineProcedure, type Procedure } from '@koala/agent-engine/procedure';
import { PROVISION_OPERATIONS, PROVISION_SERVICES } from './operations/declarations.js';
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
  describe: 'Sets up what a Koala needs after its chart, one piece at a time, each applying only what is missing and waiting until it is up: on the Koala\'s own cluster the egress proxy, SearXNG, Crawl4AI, Gitea, the npm registry mirror, Infisical and monitoring; on another of the person\'s machines only the collector that sends its metrics, logs and traces to the Koala. The setup is up once every piece is. The first piece that can never come up ends it failed with why, and nothing after it is set up; setting Koala up again starts a new run.',
  version: '1',
  budget: {},
}, (p) => {
  const open = p.hostOp('open', {}, op('provision.open'));
  const openBroke = p.finish('openBroke', { reason: out(open, 'reason') }, { outcome: 'failed' });
  const machine = p.condition('machine', { value: out(open, 'kind') }, { expression: 'value == \'machine\'' });
  const services = PROVISION_SERVICES.map((service) => p.hostOp(service, {}, op('provision.service', { service })));
  const monitoring = p.hostOp('monitoring', {}, op('provision.monitoring'));
  const markUp = p.hostOp('markUp', {}, op('provision.mark', { state: 'up' }));
  const upDone = p.finish('upDone', {}, { outcome: 'ok', reason: 'Koala is set up' });

  p.start(open);
  open.on('done', machine);
  open.on('failed', openBroke);
  const [first] = services;
  if (!first) throw new Error('the provision procedure has no platform service to set up');
  machine.on('true', monitoring);
  machine.on('false', first);

  const pieces = [...services, monitoring];
  const layout: Record<string, [number, number]> = { open: [0, 0], openBroke: [0, 200], machine: [260, 0] };
  pieces.forEach((piece, at) => {
    const name = [...PROVISION_SERVICES, 'monitoring'][at]!;
    const next = pieces[at + 1] ?? markUp;
    piece.on('done', next);
    const markFailed = p.hostOp(`${name}Failed`, { reason: out(piece, 'reason') }, op('provision.mark', { state: 'failed' }));
    const broke = p.finish(`${name}Broke`, { reason: out(piece, 'reason') }, { outcome: 'failed' });
    piece.on('failed', markFailed);
    markFailed.on('done', broke);
    markFailed.on('failed', broke);
    layout[name] = [520 + at * 260, 0];
    layout[`${name}Failed`] = [520 + at * 260, 160];
    layout[`${name}Broke`] = [520 + at * 260, 280];
  });

  const upFailed = p.hostOp('upFailed', { reason: out(markUp, 'reason') }, op('provision.mark', { state: 'failed' }));
  const upBroke = p.finish('upBroke', { reason: out(markUp, 'reason') }, { outcome: 'failed' });
  markUp.on('done', upDone);
  markUp.on('failed', upFailed);
  upFailed.on('done', upBroke);
  upFailed.on('failed', upBroke);
  const end = 520 + pieces.length * 260;
  p.layout({ ...layout, markUp: [end, 0], upDone: [end + 260, 0], upFailed: [end, 160], upBroke: [end, 280] });
}, CATALOGUE);
