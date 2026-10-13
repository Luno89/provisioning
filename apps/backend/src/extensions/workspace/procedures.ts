import { BUILT_IN_GROUPS, builtInCatalogue, defineProcedure, type Procedure } from '@koala/agent-engine/procedure';
import { WORKSPACE_OPERATIONS } from './operations/declarations.js';

export const INSTALL_IT = 'Install it';
export const DO_NOT_INSTALL = 'Do not install';

function out<T extends { readonly [socket: string]: unknown }>(node: T, socket: string): NonNullable<T[string]> {
  const found = node[socket];
  if (found === undefined) throw new Error(`the workspace procedure wires "${socket}", which that operation does not have`);
  return found as NonNullable<T[string]>;
}

const CATALOGUE = builtInCatalogue(WORKSPACE_OPERATIONS);
const op = (operation: string, settings: Record<string, unknown> = {}) => ({ operation, ...settings });

export const BUILD_WORKSPACE: Procedure = defineProcedure(BUILT_IN_GROUPS, {
  id: 'build-workspace',
  name: 'Build the workspace',
  describe: 'A tree\'s workspace built from what its project declares: read .koala/workspace.json on main, compose it with the tree type and every working agent\'s tools, build the image if anything changed — asking the person first when it would run a new install script — make it the tree\'s workspace, put back in line the stories that waited for it, and tell the project\'s channel. A failure leaves the workspace the tree had.',
  version: '1',
  budget: {},
}, (p) => {
  const read = p.hostOp('read', {}, op('workspace.read'));
  const compose = p.hostOp('compose', { tree: out(read, 'tree'), file: out(read, 'file') }, op('workspace.compose'));
  const noScript = p.condition('noScript', { value: out(compose, 'script') }, { expression: 'empty(value)' });
  const tellWaiting = p.hostOp('tellWaiting', { tree: out(read, 'tree'), summary: out(compose, 'summary') }, op('workspace.notify', { what: 'waiting' }));
  const approve = p.waitForPerson('approve', { details: out(compose, 'script') }, {
    prompt: 'This workspace would run an install script, with network access, while its image is built. Install it?',
    choices: [INSTALL_IT, DO_NOT_INSTALL],
  });
  const approved = p.condition('approved', { value: approve.answer }, { expression: `value == '${INSTALL_IT}'` });
  const build = p.hostOp('build', { plan: out(compose, 'plan') }, op('workspace.build'));
  const publish = p.hostOp('publish', { tree: out(read, 'tree'), plan: out(compose, 'plan'), file: out(read, 'file'), image: out(build, 'image'), commit: out(read, 'commit') }, op('workspace.publish'));
  const resume = p.hostOp('resume', { tree: out(read, 'tree') }, op('workspace.resume'));
  const resumeUnchanged = p.hostOp('resumeUnchanged', { tree: out(read, 'tree') }, op('workspace.resume'));
  const tellReady = p.hostOp('tellReady', { tree: out(read, 'tree'), summary: out(compose, 'summary') }, op('workspace.notify', { what: 'ready' }));
  const ready = p.finish('ready', { result: out(publish, 'published') }, { outcome: 'ok', reason: 'the workspace is built and the tree works in it' });
  const unchanged = p.finish('unchanged', {}, { outcome: 'ok', reason: 'the tree already works in this workspace' });

  const tellDeclined = p.hostOp('tellDeclined', { tree: out(read, 'tree') }, op('workspace.notify', { what: 'declined' }));
  const declined = p.finish('declined', {}, { outcome: 'refused', reason: 'the install script was declined, so the workspace was not changed' });
  const tellUnbuildable = p.hostOp('tellUnbuildable', { tree: out(read, 'tree'), reason: out(compose, 'reason') }, op('workspace.notify', { what: 'failed' }));
  const unbuildable = p.finish('unbuildable', { reason: out(compose, 'reason') }, { outcome: 'failed' });
  const tellBuildFailed = p.hostOp('tellBuildFailed', { tree: out(read, 'tree'), reason: out(build, 'reason') }, op('workspace.notify', { what: 'failed' }));
  const buildFailed = p.finish('buildFailed', { reason: out(build, 'reason') }, { outcome: 'failed' });
  const tellUnreadable = p.hostOp('tellUnreadable', { tree: out(read, 'tree'), reason: out(read, 'reason') }, op('workspace.notify', { what: 'failed' }));
  const unreadable = p.finish('unreadable', { reason: out(read, 'reason') }, { outcome: 'failed' });

  p.start(read);
  read.on('read', compose);
  read.on('unreadable', tellUnreadable);
  tellUnreadable.on('told', unreadable);
  compose.on('changed', noScript);
  compose.on('unchanged', resumeUnchanged);
  resumeUnchanged.on('resumed', unchanged);
  resumeUnchanged.on('none', unchanged);
  compose.on('unbuildable', tellUnbuildable);
  noScript.on('true', build);
  noScript.on('false', tellWaiting);
  tellWaiting.on('told', approve);
  approve.on('answered', approved);
  approve.on('unanswered', tellDeclined);
  approved.on('true', build);
  approved.on('false', tellDeclined);
  build.on('built', publish);
  build.on('failed', tellBuildFailed);
  publish.on('published', resume);
  resume.on('resumed', tellReady);
  resume.on('none', tellReady);
  tellReady.on('told', ready);
  tellDeclined.on('told', declined);
  tellUnbuildable.on('told', unbuildable);
  tellBuildFailed.on('told', buildFailed);
  p.layout({
    read: [0, 0], tellUnreadable: [0, 160], unreadable: [0, 320],
    compose: [260, 0], resumeUnchanged: [260, 160], unchanged: [260, 320], tellUnbuildable: [260, 480], unbuildable: [260, 640],
    noScript: [520, 0], tellWaiting: [520, 160], approve: [780, 160], approved: [1040, 160], tellDeclined: [1040, 320], declined: [1040, 480],
    build: [1040, 0], tellBuildFailed: [1300, 160], buildFailed: [1300, 320],
    publish: [1300, 0], resume: [1560, 0], tellReady: [1820, 0], ready: [2080, 0],
  });
}, CATALOGUE);
