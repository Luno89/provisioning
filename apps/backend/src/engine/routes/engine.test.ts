import { beforeEach, describe, expect, it } from 'vitest';
import { mock, mockFn } from 'vitest-mock-extended';
import { WorkStopped } from '@koala/engine-core/work-for';
import type { RequestHandler } from 'express';
import { defineGroup, type EngineExtension } from '@koala/agent-engine/procedure';
import type { Persona } from '@koala/agent-engine';
import { containing, objectWith } from '../../platform/lib/test-matchers.js';
import {
  EngineUnavailableError, MachineUnavailableError, UnknownAgentError, UnknownProcedureError,
  type AgentRegistry, type RunStarter, type Task,
} from '../../engine-host/index.js';
import { SwitchedOffError } from '../lib/extension-settings.js';
import { NoNoteToAskError } from '../lib/conversations.js';
import type { RunEnding } from '../store.js';
import type { ApprovalService } from '../services/ApprovalService.js';
import type { ExtensionService, ExtensionState } from '../services/ExtensionService.js';
import { TEST_USER } from '../../platform/routes/test-harness.js';
import { routesInProcess, type InProcessRoutes } from '../../platform/testing/routes.js';
import { engineRouter, extensionSummary, type EngineRouterDeps, type TaskAccess, type TraceAccess, type WorkspaceImageAccess } from './engine.js';

type Extensions = Pick<ExtensionService, 'list' | 'setEnabled' | 'create' | 'update' | 'remove' | 'publish' | 'removeOperation'>;
type Approvals = Pick<ApprovalService, 'approve' | 'answer' | 'cancel'>;
type Endings = NonNullable<EngineRouterDeps['endings']>;

const extension = (over: Partial<EngineExtension> = {}): EngineExtension => ({ id: 'grove', title: 'Grove', describe: 'Grows trees.', version: '1', ...over });
const state = (over: Partial<ExtensionState> = {}): ExtensionState => ({ extension: extension(), enabled: true, alwaysOn: false, authored: false, ...over });

const persona = (over: Partial<Persona> = {}): Persona => ({
  slug: 'koala', name: 'Koala', description: 'Chats', version: '1', prompt: 'p', guidance: '', returns: '', failures: [], procedure: 'interactive-chat', tools: ['read_file'],
  environment: { terminal: true, filesystem: true }, ...over,
});

const task = (over: Partial<Task> & Pick<Task, 'id'>): Task => ({ ownerId: TEST_USER.id, title: over.id, doneMeans: 'it works', dependsOn: [], status: 'proposed', runs: [], createdAt: 'now', updatedAt: 'now', ...over });

let runs: ReturnType<typeof mock<RunStarter>>;
let registry: ReturnType<typeof mock<AgentRegistry>>;
let approvals: ReturnType<typeof mock<Approvals>>;
let extensions: ReturnType<typeof mock<Extensions>>;
let tasks: ReturnType<typeof mock<TaskAccess>>;
let traces: ReturnType<typeof mock<TraceAccess>>;
let endings: ReturnType<typeof mock<Endings>>;
let images: ReturnType<typeof mock<WorkspaceImageAccess>>;
let app: InProcessRoutes;

const mount = (over: Partial<EngineRouterDeps> = {}) => routesInProcess({
  prefix: '/api/engine',
  router: () => engineRouter({ runs, registry, approvals, extensions, tasks, traces, endings, images, ...over }),
});

beforeEach(async () => {
  runs = mock<RunStarter>();
  registry = mock<AgentRegistry>();
  approvals = mock<Approvals>();
  extensions = mock<Extensions>();
  tasks = mock<TaskAccess>();
  traces = mock<TraceAccess>();
  endings = mock<Endings>();
  images = mock<WorkspaceImageAccess>();
  app = await mount();
});

describe('what an extension is summed up as', () => {
  it('says what it brings by name, and that it requires nothing when it says nothing', () => {
    expect(extensionSummary(state({ latest: ['x.y@1'], authored: true, extension: extension({ tools: [{ name: 't1' }] as never, personas: [{ slug: 'p1' }] as never, procedures: [{ id: 'pr1' }] as never }) }))).toEqual({
      id: 'grove', title: 'Grove', describe: 'Grows trees.', version: '1', enabled: true, alwaysOn: false, authored: true, latest: ['x.y@1'],
      requires: [], operations: [], groups: [], tools: ['t1'], personas: ['p1'], procedures: ['pr1'],
    });
    expect(extensionSummary(state())).not.toHaveProperty('latest');
  });
});

describe('extensions', () => {
  it('serves each extension\'s vocabulary and whether the caller has it on', async () => {
    extensions.list.calledWith(TEST_USER.id).mockResolvedValue([state({ extension: extension({ requires: ['platform'] }) })]);
    expect(await app.get('/api/engine/extensions')).toMatchObject({ status: 200, data: [{ id: 'grove', enabled: true, requires: ['platform'] }] });
  });

  it('serves none where extensions are not wired', async () => {
    const bare = await mount({ extensions: undefined });
    expect(await bare.get('/api/engine/extensions')).toMatchObject({ status: 200, data: [] });
    const unavailable = { status: 503, data: { error: 'extensions are not available here' } };
    expect(await bare.post('/api/engine/extensions', { id: 'x', title: 'X' })).toMatchObject(unavailable);
    expect(await bare.put('/api/engine/extensions/x', {})).toMatchObject(unavailable);
    expect(await bare.delete('/api/engine/extensions/x')).toMatchObject(unavailable);
    expect(await bare.post('/api/engine/extensions/x/operations', {})).toMatchObject(unavailable);
    expect(await bare.delete('/api/engine/extensions/x/operations/y')).toMatchObject(unavailable);
    expect(await bare.put('/api/engine/extensions/x/enabled', { enabled: true })).toMatchObject(unavailable);
  });

  it('switches one on or off for the caller, answering the list', async () => {
    extensions.setEnabled.mockResolvedValue({ ok: true, value: [state({ enabled: false })] });
    expect(await app.put('/api/engine/extensions/grove/enabled', { enabled: false })).toMatchObject({ status: 200, data: [{ id: 'grove', enabled: false }] });
    expect(extensions.setEnabled).toHaveBeenCalledWith(TEST_USER.id, 'grove', false);
  });

  it('refuses a switch that is not true or false before the service is asked, and answers the service\'s refusal as it gave it', async () => {
    expect(await app.put('/api/engine/extensions/grove/enabled', { enabled: 'yes' })).toMatchObject({ status: 400, data: { error: 'say whether the extension is enabled, as true or false' } });
    expect(extensions.setEnabled).not.toHaveBeenCalled();
    extensions.setEnabled.mockResolvedValue({ ok: false, status: 409, error: 'Workspace needs Grove, so switch that off first' });
    expect(await app.put('/api/engine/extensions/grove/enabled', { enabled: false })).toMatchObject({ status: 409, data: { error: 'Workspace needs Grove, so switch that off first' } });
  });

  it('makes an extension from an id, a title and an optional description', async () => {
    extensions.create.mockResolvedValue({ ok: true, value: [state({ extension: extension({ id: 'loud', title: 'Loud' }), authored: true })] });
    expect(await app.post('/api/engine/extensions', { id: 'loud', title: 'Loud', describe: 'Shouts.' })).toMatchObject({ status: 200, data: [{ id: 'loud', authored: true }] });
    expect(extensions.create).toHaveBeenCalledWith(TEST_USER.id, { id: 'loud', title: 'Loud', describe: 'Shouts.' });
    await app.post('/api/engine/extensions', { describe: 7 });
    expect(extensions.create).toHaveBeenLastCalledWith(TEST_USER.id, { id: '', title: '', describe: undefined });
    extensions.create.mockResolvedValue({ ok: false, status: 400, error: 'there is already an extension called grove' });
    expect(await app.post('/api/engine/extensions', { id: 'grove', title: 'Mine' })).toMatchObject({ status: 400, data: { error: 'there is already an extension called grove' } });
  });

  it('updates what an extension bundles, and removes it', async () => {
    extensions.update.mockResolvedValue({ ok: true, value: [state({ extension: extension({ title: 'Louder' }) })] });
    expect(await app.put('/api/engine/extensions/loud', { title: 'Louder' })).toMatchObject({ status: 200, data: [{ title: 'Louder' }] });
    expect(extensions.update).toHaveBeenCalledWith(TEST_USER.id, 'loud', { title: 'Louder' });
    extensions.remove.mockResolvedValue({ ok: false, status: 409, error: 'greeter still uses its operations' });
    expect(await app.delete('/api/engine/extensions/loud')).toMatchObject({ status: 409, data: { error: 'greeter still uses its operations' } });
  });

  it('publishes a group as an operation and answers what it made', async () => {
    const group = defineGroup('shout', {
      title: 'Shout', describe: 'Passes it on.',
      inputs: { text: { type: 'text', describe: 'What to say.', required: true } },
      outputs: {},
      exits: { done: { describe: 'Said.' }, quiet: { describe: 'Nothing said.' } },
    }, (g) => {
      const said = g.condition('said', { value: g.inputs.text }, { expression: 'not empty(value)' });
      g.start(said);
      said.on('true', g.exits.done);
      said.on('false', g.exits.quiet);
      g.layout({ said: [0, 0] });
    });
    extensions.publish.mockResolvedValue({ ok: true, value: { id: 'loud.shout@1', version: 1, moved: [] } });
    expect(await app.post('/api/engine/extensions/loud/operations', { name: 'shout', group })).toMatchObject({ status: 200, data: { id: 'loud.shout@1', version: 1, moved: [] } });
    expect(extensions.publish).toHaveBeenCalledWith(TEST_USER.id, 'loud', 'shout', JSON.parse(JSON.stringify(group)));
  });

  it('refuses a publish with no group before the service is asked', async () => {
    expect(await app.post('/api/engine/extensions/loud/operations', { name: 'shout' })).toMatchObject({ status: 400, data: { error: 'send the group to publish as "group"' } });
    expect(await app.post('/api/engine/extensions/loud/operations', { name: 'shout', group: 'nope' })).toMatchObject({ status: 400 });
    expect(extensions.publish).not.toHaveBeenCalled();
  });

  it('removes an operation and answers the list, or why it cannot', async () => {
    extensions.removeOperation.mockResolvedValueOnce({ ok: true, value: [state()] });
    expect(await app.delete('/api/engine/extensions/loud/operations/shout')).toMatchObject({ status: 200, data: [{ id: 'grove' }] });
    expect(extensions.removeOperation).toHaveBeenCalledWith(TEST_USER.id, 'loud', 'shout');
    extensions.removeOperation.mockResolvedValueOnce({ ok: false, status: 404, error: 'Loud has no operation called "shout"' });
    expect(await app.delete('/api/engine/extensions/loud/operations/shout')).toMatchObject({ status: 404 });
  });
});

describe('the agents a person can run', () => {
  it('lists them with what they hold and who can delegate to whom, marking the person\'s own', async () => {
    registry.agents.calledWith(TEST_USER.id).mockResolvedValue([persona(), persona({ slug: 'mine', ownerId: TEST_USER.id, agents: ['koala'] })]);
    const listed = await app.get<{ slug: string; mine: boolean; canDelegateTo: string[]; loop: string; inputs: unknown }[]>('/api/engine/agents');
    expect(listed.data.map((agent) => [agent.slug, agent.mine, agent.canDelegateTo, agent.loop, agent.inputs])).toEqual([['koala', false, [], 'interactive-chat', null], ['mine', true, ['koala'], 'interactive-chat', null]]);
  });
});

describe('work', () => {
  it('lists work with whether it can start and what it is waiting on', async () => {
    tasks.list.calledWith(TEST_USER.id).mockResolvedValue([task({ id: 'first', status: 'running' }), task({ id: 'second', status: 'accepted', dependsOn: ['first'] }), task({ id: 'third', status: 'accepted' })]);
    const listed = await app.get<{ id: string; ready: boolean; waitingOn: unknown[] }[]>('/api/engine/tasks');
    expect(listed.data.find((one) => one.id === 'second')).toMatchObject({ ready: false, waitingOn: [{ id: 'first', title: 'first', status: 'running' }] });
    expect(listed.data.find((one) => one.id === 'third')).toMatchObject({ ready: true, waitingOn: [] });
  });

  it('filters work by status, and lists none where work is not tracked', async () => {
    tasks.list.mockResolvedValue([task({ id: 'a', status: 'proposed' }), task({ id: 'b', status: 'done' })]);
    expect((await app.get<{ id: string }[]>('/api/engine/tasks?status=proposed')).data.map((one) => one.id)).toEqual(['a']);
    const bare = await mount({ tasks: undefined });
    expect(await bare.get('/api/engine/tasks')).toMatchObject({ status: 200, data: [] });
  });

  it('accepts and drops proposed work, and says which task is missing', async () => {
    tasks.list.mockResolvedValue([task({ id: 'a', status: 'proposed' })]);
    expect(await app.post('/api/engine/tasks/a/accept')).toMatchObject({ status: 200, data: { id: 'a', status: 'accepted' } });
    expect(tasks.save).toHaveBeenLastCalledWith(objectWith({ id: 'a', status: 'accepted' }));
    expect(await app.post('/api/engine/tasks/a/drop')).toMatchObject({ status: 200, data: { status: 'dropped' } });
    expect(await app.post('/api/engine/tasks/ghost/accept')).toMatchObject({ status: 404, data: { error: 'No such task' } });
  });

  it('tells the accepted work to the one waiting on a workspace, and answers it as it then stands', async () => {
    const accepted = mockFn<NonNullable<EngineRouterDeps['accepted']>>();
    accepted.mockResolvedValue({ waiting: ['a'] });
    tasks.list.mockResolvedValueOnce([task({ id: 'a', status: 'proposed' })]).mockResolvedValue([task({ id: 'a', status: 'waiting' })]);
    const waiting = await mount({ accepted });
    expect(await waiting.post('/api/engine/tasks/a/accept')).toMatchObject({ status: 200, data: { id: 'a', status: 'waiting' } });
    expect(accepted).toHaveBeenCalledWith(TEST_USER.id, objectWith({ id: 'a', status: 'accepted' }));
  });

  it('says work is not tracked where it is not', async () => {
    const bare = await mount({ tasks: undefined });
    expect(await bare.post('/api/engine/tasks/a/accept')).toMatchObject({ status: 503, data: { error: 'Work is not being tracked on this server.' } });
    expect((await bare.post('/api/engine/tasks/a/drop')).status).toBe(503);
  });
});

describe('starting a run', () => {
  const started = { runId: 'run-1', agentSlug: 'koala', loopId: 'interactive-chat' };

  beforeEach(() => {
    runs.start.mockResolvedValue(started);
  });

  it('starts a run for the caller as a person and reports which loop it is running', async () => {
    expect(await app.post('/api/engine/runs', { agent: 'koala', message: 'hello there' })).toMatchObject({ status: 201, data: started });
    expect(runs.start).toHaveBeenCalledWith({ ownerId: TEST_USER.id, startedBy: 'person', agentSlug: 'koala', message: 'hello there' });
  });

  it('carries the conversation, the model and how far it reaches, the procedure, the inputs and the note it asks about', async () => {
    await app.post('/api/engine/runs', {
      agent: 'koala', message: 'hi', conversationId: 'c1', modelId: 'm1', modelReach: 'chat', procedure: ' research ', inputs: { treeId: 't1' }, asks: '2026-10-11T17:59:09.231Z',
    });
    expect(runs.start).toHaveBeenCalledWith({
      ownerId: TEST_USER.id, startedBy: 'person', agentSlug: 'koala', message: 'hi', conversationId: 'c1', modelId: 'm1', modelReach: 'chat', procedureId: 'research',
      inputs: { treeId: 't1' }, asks: '2026-10-11T17:59:09.231Z',
    });
  });

  it('drops a reach it does not know, an empty model and an input that is not an object', async () => {
    await app.post('/api/engine/runs', { agent: 'koala', message: 'hi', modelReach: 'everyone', modelId: '', procedure: '  ', inputs: 'x' });
    expect(runs.start).toHaveBeenCalledWith({ ownerId: TEST_USER.id, startedBy: 'person', agentSlug: 'koala', message: 'hi' });
  });

  it('turns a temperature into sampling for both kinds of turn, and refuses one out of range', async () => {
    await app.post('/api/engine/runs', { agent: 'executor', message: 'go', temperature: 0.4 });
    expect(runs.start).toHaveBeenCalledWith(objectWith({ sampling: { toolTurn: { temperature: 0.4 }, conversation: { temperature: 0.4 } } }));
    runs.start.mockClear();
    expect(await app.post('/api/engine/runs', { agent: 'executor', message: 'go', temperature: 5 })).toMatchObject({ status: 400 });
    expect(runs.start).not.toHaveBeenCalled();
  });

  it('rejects a run with no agent or no message', async () => {
    expect(await app.post('/api/engine/runs', { message: 'hi' })).toMatchObject({ status: 400, data: { error: 'agent is required' } });
    expect(await app.post('/api/engine/runs', { agent: ' ', message: 'hi' })).toMatchObject({ status: 400 });
    expect(await app.post('/api/engine/runs', { agent: 'koala', message: '  ' })).toMatchObject({ status: 400, data: { error: 'message is required' } });
    expect(runs.start).not.toHaveBeenCalled();
  });

  it('refuses a note to ask about that is not a time, or that names no conversation', async () => {
    const asks = { status: 400, data: { error: 'asks names the time of a posted message, and needs its conversationId' } };
    expect(await app.post('/api/engine/runs', { agent: 'koala', message: 'hi', conversationId: 'c1', asks: 7 })).toMatchObject(asks);
    expect(await app.post('/api/engine/runs', { agent: 'koala', message: 'hi', asks: 'x' })).toMatchObject(asks);
    expect(await app.post('/api/engine/runs', { agent: 'koala', message: 'hi', conversationId: 'c1', asks: '' })).toMatchObject(asks);
    expect(runs.start).not.toHaveBeenCalled();
  });

  it('attaches files from the person\'s own projects, and refuses ones from anyone else\'s', async () => {
    const projects = mockFn<NonNullable<EngineRouterDeps['projects']>>();
    projects.calledWith(TEST_USER.id).mockResolvedValue([{ id: 'p1', name: 'Shop' }]);
    const attachable = mockFn<NonNullable<EngineRouterDeps['attachable']>>();
    attachable.calledWith(TEST_USER.id, 'f1').mockResolvedValue({ id: 'f1', path: 'docs/a.md', size: 4, contentType: 'text/markdown', projectId: 'p1' });
    attachable.calledWith(TEST_USER.id, 'f2').mockResolvedValue({ id: 'f2', path: 'a.md', size: 4, contentType: 'text/markdown', projectId: 'p2' });
    const withProjects = await mount({ projects, attachable });
    await withProjects.post('/api/engine/runs', { agent: 'koala', message: 'see', attachments: [{ fileId: 'f1' }] });
    expect(runs.start).toHaveBeenCalledWith(objectWith({ attachments: [{ fileId: 'f1', name: 'a.md', size: 4, type: 'text/markdown', project: { id: 'p1', name: 'Shop' } }] }));
    expect(await withProjects.post('/api/engine/runs', { agent: 'koala', message: 'see', attachments: [{ fileId: 'f2' }] })).toMatchObject({ status: 400, data: { error: 'f2 is kept in a project that is not yours' } });
    expect(await withProjects.post('/api/engine/runs', { agent: 'koala', message: 'see', attachments: [{ fileId: 'f3' }] })).toMatchObject({ status: 400, data: { error: 'f3 is not a file you keep' } });
    expect(await app.post('/api/engine/runs', { agent: 'koala', message: 'see', attachments: [{ fileId: 'f1' }] })).toMatchObject({ status: 400, data: { error: 'files cannot be attached to a message here' } });
  });

  it('says plainly why a run could not start, with the code the browser reads', async () => {
    const refuse = async (error: Error) => { runs.start.mockRejectedValueOnce(error); return app.post<{ error: string; code?: string }>('/api/engine/runs', { agent: 'koala', message: 'hi' }); };
    expect(await refuse(new EngineUnavailableError())).toMatchObject({ status: 503 });
    expect(await refuse(new WorkStopped({ kind: 'owner', id: TEST_USER.id }))).toMatchObject({ status: 409, data: { error: 'this account is being removed' } });
    expect(await refuse(new UnknownAgentError('ghost'))).toMatchObject({ status: 404, data: { error: containing('ghost') } });
    expect(await refuse(new UnknownProcedureError('nowhere'))).toMatchObject({ status: 404, data: { error: containing('nowhere') } });
    expect(await refuse(new MachineUnavailableError('it is offline'))).toMatchObject({ status: 409, data: { code: 'MACHINE_UNAVAILABLE' } });
    expect(await refuse(new SwitchedOffError('research', [{ node: 'n', message: 'is off' }]))).toMatchObject({ status: 409, data: { code: 'SWITCHED_OFF' } });
    expect(await refuse(new NoNoteToAskError('2026-10-11'))).toMatchObject({ status: 409, data: { error: containing('not been asked about') } });
  });

  it('lets a failure it does not know through as an error', async () => {
    runs.start.mockRejectedValueOnce(new Error('the database is down'));
    expect(await app.post('/api/engine/runs', { agent: 'koala', message: 'hi' })).toMatchObject({ status: 500, data: { error: 'the database is down' } });
  });
});

describe('a run once it is going', () => {
  it('returns the traces of a run, and none where traces are not wired', async () => {
    traces.list.calledWith(TEST_USER.id, 'run-1').mockResolvedValue([]);
    expect(await app.get('/api/engine/runs/run-1/traces')).toMatchObject({ status: 200, data: { traces: [] } });
    const bare = await mount({ traces: undefined });
    expect(await bare.get('/api/engine/runs/run-1/traces')).toMatchObject({ status: 200, data: { traces: [] } });
  });

  it('says how runs ended, asking for at most a hundred named', async () => {
    const ending: RunEnding = { runId: 'r1', ownerId: TEST_USER.id };
    endings.list.mockResolvedValue([ending]);
    expect(await app.get('/api/engine/runs/endings?ids=r1,%20r2,,')).toMatchObject({ status: 200, data: { endings: [{ runId: 'r1' }] } });
    expect(endings.list).toHaveBeenCalledWith(TEST_USER.id, ['r1', 'r2']);
    const many = Array.from({ length: 150 }, (_, index) => `r${index}`).join(',');
    await app.get(`/api/engine/runs/endings?ids=${many}`);
    expect(endings.list.mock.calls.at(-1)?.[1]).toHaveLength(100);
  });

  it('says no run ended when none is named or endings are not wired', async () => {
    expect(await app.get('/api/engine/runs/endings')).toMatchObject({ status: 200, data: { endings: [] } });
    expect(endings.list).not.toHaveBeenCalled();
    const bare = await mount({ endings: undefined });
    expect(await bare.get('/api/engine/runs/endings?ids=r1')).toMatchObject({ status: 200, data: { endings: [] } });
  });

  it('signals an answer into a waiting run, and only into the person\'s own', async () => {
    approvals.answer.calledWith(TEST_USER.id, 'run-1', 'ask', 'staging').mockResolvedValue('sent');
    approvals.answer.calledWith(TEST_USER.id, 'run-theirs', 'decide', 'Cut over').mockResolvedValue('not-yours');
    expect(await app.post('/api/engine/runs/run-1/answer', { nodeId: 'ask', value: 'staging' })).toMatchObject({ status: 200, data: { ok: true } });
    expect(await app.post('/api/engine/runs/run-theirs/answer', { nodeId: 'decide', value: 'Cut over' })).toMatchObject({ status: 404, data: { error: 'You have no run with that id' } });
    expect(await app.post('/api/engine/runs/run-1/answer', { value: 'x' })).toMatchObject({ status: 400, data: { error: 'nodeId is required' } });
  });

  it('says plainly when an answer cannot be sent', async () => {
    approvals.answer.mockRejectedValue(new EngineUnavailableError());
    expect(await app.post('/api/engine/runs/run-1/answer', { nodeId: 'ask' })).toMatchObject({ status: 503 });
  });

  it('carries an approval decision, whether it stands for the rest of the run, and the chat it was made in', async () => {
    approvals.approve.mockResolvedValue('sent');
    expect(await app.post('/api/engine/runs/run-1/approve', { callId: 'c1', allowed: true, forRun: true, conversationId: 'conv', tool: 'run_command', auto: 'tree' })).toMatchObject({ status: 200, data: { ok: true } });
    expect(approvals.approve).toHaveBeenCalledWith(TEST_USER.id, 'run-1', { callId: 'c1', allowed: true, forRun: true, conversation: { id: 'conv', tool: 'run_command' }, auto: 'tree' });
    await app.post('/api/engine/runs/run-1/approve', { callId: 'c2', allowed: false });
    expect(approvals.approve).toHaveBeenLastCalledWith(TEST_USER.id, 'run-1', { callId: 'c2', allowed: false, forRun: false, conversation: undefined });
  });

  it('requires an explicit allow or deny and a call to answer', async () => {
    expect(await app.post('/api/engine/runs/run-1/approve', { callId: 'c1' })).toMatchObject({ status: 400, data: { error: 'allowed must be true or false' } });
    expect(await app.post('/api/engine/runs/run-1/approve', { allowed: true })).toMatchObject({ status: 400, data: { error: 'callId is required' } });
    expect(await app.post('/api/engine/runs/run-1/approve', { callId: 'c1', allowed: true, auto: 'everything' })).toMatchObject({ status: 400, data: { error: 'auto is agent or tree' } });
    expect(approvals.approve).not.toHaveBeenCalled();
  });

  it('answers an approval it refused, did not find or could not send in the words and status that fit', async () => {
    approvals.approve.mockResolvedValueOnce({ refused: 'auto mode cannot be set from a member\'s run' });
    approvals.approve.mockResolvedValueOnce('not-yours');
    approvals.approve.mockResolvedValueOnce('no-such-conversation');
    approvals.approve.mockRejectedValueOnce(new EngineUnavailableError());
    const approve = () => app.post('/api/engine/runs/run-1/approve', { callId: 'c1', allowed: true });
    expect(await approve()).toMatchObject({ status: 409, data: { error: 'auto mode cannot be set from a member\'s run' } });
    expect(await approve()).toMatchObject({ status: 404, data: { error: 'You have no run with that id' } });
    expect(await approve()).toMatchObject({ status: 404, data: { error: 'You have no conversation with that id' } });
    expect(await approve()).toMatchObject({ status: 503 });
  });

  it('cancels a run, only the person\'s own, saying who stopped it', async () => {
    approvals.cancel.calledWith(TEST_USER.id, 'run-1', TEST_USER.email).mockResolvedValue('sent');
    approvals.cancel.calledWith(TEST_USER.id, 'run-theirs', TEST_USER.email).mockResolvedValue('not-yours');
    expect(await app.post('/api/engine/runs/run-1/cancel')).toMatchObject({ status: 200, data: { ok: true } });
    expect(await app.post('/api/engine/runs/run-theirs/cancel')).toMatchObject({ status: 404, data: { error: 'You have no run with that id' } });
    approvals.cancel.mockRejectedValue(new EngineUnavailableError());
    expect((await app.post('/api/engine/runs/run-1/cancel')).status).toBe(503);
  });
});

describe('workspace images', () => {
  it('lists the images standing for the caller, and says where none are wired', async () => {
    images.standing.calledWith(TEST_USER.id).mockResolvedValue([{ agent: 'executor', fingerprint: 'f1', state: 'ready', reference: 'r/koala:f1' }]);
    expect(await app.get('/api/engine/images')).toMatchObject({ status: 200, data: { images: [{ agent: 'executor' }] } });
    const bare = await mount({ images: undefined });
    expect(await bare.get('/api/engine/images')).toMatchObject({ status: 404, data: { error: 'Workspace images are not wired here' } });
  });

  it('sweeps images only for an administrator, and says when there is nothing to sweep with', async () => {
    const admin: RequestHandler = (_req, _res, next) => next();
    const refuse: RequestHandler = (_req, res) => { res.status(403).json({ error: 'administrators only' }); };
    images.prune.mockResolvedValueOnce({ removed: ['f0'], kept: [], tooNew: [], failed: [] });
    const asAdmin = await mount({ admin });
    expect(await asAdmin.post('/api/engine/images/prune')).toMatchObject({ status: 200, data: { report: { removed: ['f0'] } } });
    images.prune.mockResolvedValueOnce(undefined);
    expect(await asAdmin.post('/api/engine/images/prune')).toMatchObject({ status: 501, data: { error: 'There is no registry account, so there is nothing to sweep' } });

    images.prune.mockClear();
    const asPerson = await mount({ admin: refuse });
    expect(await asPerson.post('/api/engine/images/prune')).toMatchObject({ status: 403 });
    expect(images.prune).not.toHaveBeenCalled();
  });

  it('mounts no sweep without an administrator\'s guard', async () => {
    expect((await app.post('/api/engine/images/prune')).status).toBe(404);
  });
});
