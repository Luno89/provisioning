import { BUILT_IN_GROUPS, builtInCatalogue, defineProcedure, type Procedure } from '@koala/agent-engine/procedure';
import { MCP_OPERATIONS } from './operations/declarations.js';

function out<T extends { readonly [socket: string]: unknown }>(node: T, socket: string): NonNullable<T[string]> {
  const found = node[socket];
  if (found === undefined) throw new Error(`the capture procedure wires "${socket}", which that operation does not have`);
  return found as NonNullable<T[string]>;
}

const CATALOGUE = builtInCatalogue(MCP_OPERATIONS);
const op = (operation: string, settings: Record<string, unknown> = {}) => ({ operation, ...settings });

export const CAPTURE_MCP_SERVER: Procedure = defineProcedure(BUILT_IN_GROUPS, {
  id: 'capture-mcp-server',
  name: 'Capture an MCP server',
  describe: 'What an MCP server says about itself, kept on its record: open it from the catalogue; a hosted one is connected to; a workspace one has its image built and is started in this run\'s own sandbox. Its instructions and tools are recorded, or why it could not be captured. The sandbox goes when the run ends.',
  version: '1',
  budget: {},
}, (p) => {
  const open = p.hostOp('open', {}, op('mcp.open'));
  const connect = p.hostOp('connect', { server: out(open, 'server') }, op('mcp.connect'));
  const build = p.hostOp('build', { server: out(open, 'server') }, op('mcp.build'));
  const start = p.hostOp('start', { server: out(open, 'server'), image: out(build, 'image') }, op('mcp.start'));
  const keepHosted = p.hostOp('keepHosted', { server: out(open, 'server'), captured: out(connect, 'captured') }, op('mcp.record', { what: 'captured' }));
  const keepStarted = p.hostOp('keepStarted', { server: out(open, 'server'), captured: out(start, 'captured') }, op('mcp.record', { what: 'captured' }));
  const unreachable = p.hostOp('unreachable', { server: out(open, 'server'), reason: out(connect, 'reason') }, op('mcp.record', { what: 'failed' }));
  const unbuilt = p.hostOp('unbuilt', { server: out(open, 'server'), reason: out(build, 'reason') }, op('mcp.record', { what: 'failed' }));
  const unstarted = p.hostOp('unstarted', { server: out(open, 'server'), reason: out(start, 'reason') }, op('mcp.record', { what: 'failed' }));
  const captured = p.finish('captured', { result: out(keepHosted, 'summary') }, { outcome: 'ok', reason: 'the server is captured' });
  const capturedStarted = p.finish('capturedStarted', { result: out(keepStarted, 'summary') }, { outcome: 'ok', reason: 'the server is captured' });
  const failed = p.finish('failed', { reason: out(unreachable, 'summary') }, { outcome: 'failed' });
  const failedBuild = p.finish('failedBuild', { reason: out(unbuilt, 'summary') }, { outcome: 'failed' });
  const failedStart = p.finish('failedStart', { reason: out(unstarted, 'summary') }, { outcome: 'failed' });
  const missing = p.finish('missing', { reason: out(open, 'reason') }, { outcome: 'failed' });
  const release = p.hostOp('release', {}, op('mcp.release'));
  const released = p.finish('released', {}, { outcome: 'ok' });

  p.start(open);
  p.cleanup(release);
  release.on('done', released);
  open.on('hosted', connect);
  open.on('workspace', build);
  open.on('missing', missing);
  connect.on('captured', keepHosted);
  connect.on('failed', unreachable);
  keepHosted.on('recorded', captured);
  unreachable.on('recorded', failed);
  build.on('built', start);
  build.on('failed', unbuilt);
  unbuilt.on('recorded', failedBuild);
  start.on('captured', keepStarted);
  start.on('failed', unstarted);
  keepStarted.on('recorded', capturedStarted);
  unstarted.on('recorded', failedStart);
  p.layout({
    open: [0, 0], missing: [0, 160],
    connect: [260, -160], keepHosted: [520, -160], captured: [780, -160], unreachable: [520, -320], failed: [780, -320],
    build: [260, 160], unbuilt: [260, 320], failedBuild: [260, 480],
    start: [520, 160], unstarted: [520, 320], failedStart: [520, 480],
    keepStarted: [780, 160], capturedStarted: [1040, 160],
    release: [0, 480], released: [0, 640],
  });
}, CATALOGUE);
