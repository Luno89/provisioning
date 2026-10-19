import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)) });
import axios, { type AxiosInstance } from 'axios';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import { signJWT } from '../apps/backend/src/lib/auth.js';
import { loadKeys } from '../apps/backend/src/lib/keys.js';
import { getTemporalClient } from '../apps/backend/src/lib/temporal-client.js';
import { conversationRepoName } from '../apps/backend/src/engine-host/sandboxes/workspace-repos.js';
import type { AgentScript } from '../apps/local-agent/src/acp-script-agent.js';
import { forgetWhatRunsLeft } from './lib/forget-test-runs.js';

const run = promisify(execFile);
const BASE = process.env.MACHINE_CHAT_LIVE_URL ?? 'http://localhost:3001/api';
const AGENT = 'koala-script';
const SCRIPT_AGENT = fileURLToPath(new URL('../apps/local-agent/src/acp-script-agent.ts', import.meta.url));
const TSX_LOADER = new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href;
const LABEL = 'Axial Concepts';
const PAST_THE_JOB_CUTOFF_MS = 170_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (message: string) => console.log(`\n▶ ${message}`);

interface ManualAgent { id: string; title?: string; command: string; args: string[] }
interface Device { id: string; name: string; online: boolean; agents: { id: string; state: string; reason?: string }[]; manualAgents: ManualAgent[] }
interface TurnEvent { type: string; runId: string; callId?: string; name?: string; ok?: boolean; digest?: string; level?: string; message?: string; outcome?: string; reason?: string; parentRunId?: string }
interface StoredCall { id: string; name: string; ok: boolean; digest: string; child?: { runId: string; agentId: string; outcome: string; steps: { callId: string; name: string; ok?: boolean }[] } }
interface Told { cwd: string; prompt: string; servers: { server: string; tools: { name: string }[] }[] }

async function until<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
  for (let tries = 1; ; tries += 1) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (tries % 12 === 0) console.log(`  still waiting for ${what}`);
    await sleep(5000);
  }
}

let api: AxiosInstance | undefined;
let device: Device | undefined;
let scratch: string | undefined;
const conversations: string[] = [];
const turns: string[] = [];
let closeDb: (() => Promise<void>) | undefined;
let retire: (() => Promise<void>) | undefined;

async function main(): Promise<void> {
  const machine = JSON.parse(await readFile(path.join(homedir(), '.config/koala/machine.json'), 'utf8')) as { deviceId: string; token: string };
  const deviceId = process.env.MACHINE_CHAT_DEVICE ?? machine.deviceId;
  const db = createDatabase();
  await db.init();
  closeDb = async () => { await db.close?.(); };
  const owner = (await db.getLocalAgentDevices()).find((entry) => entry.id === deviceId)?.ownerId;
  assert.ok(owner, `there is no machine ${deviceId}`);
  const user = await db.getUserById(owner);
  assert.ok(user, 'the machine\'s owner is gone');
  api = axios.create({ baseURL: BASE, proxy: false, validateStatus: () => true, headers: { Cookie: `session=${signJWT({ userId: user.id, email: user.email }, loadKeys(process.env).session, 7200)}` } });
  const temporal = await getTemporalClient();
  const runIds = new Set<string>();
  const began = new Date().toISOString();
  retire = async () => {
    step('whatever the memory keeper keeps from these made-up chats is retired');
    for await (const workflow of temporal.workflow.list({ query: `WorkflowId STARTS_WITH "memory-" AND StartTime >= "${began}"` })) runIds.add(workflow.workflowId);
    const forgotten = await forgetWhatRunsLeft(db, owner, new Set([...runIds, ...[...runIds].map((id) => `memory-run-${id}`)]));
    console.log(`  ${forgotten} kept thing${forgotten === 1 ? '' : 's'} retired`);
  };
  const stamp = Date.now().toString(36);
  const choice = `machine:${deviceId}:${AGENT}`;

  const events = async (runId: string): Promise<TurnEvent[]> =>
    ((await api!.get(`/turns/${runId}`)).data as { entries: { events: TurnEvent[] }[] }).entries.flatMap((entry) => entry.events);
  const finished = async (runId: string): Promise<TurnEvent[]> => {
    await temporal.workflow.getHandle(runId).result().catch(() => undefined);
    const all = await events(runId);
    for (const event of all) if (event.type === 'run.started') runIds.add(event.runId);
    return all;
  };
  const lastReply = async (conversationId: string): Promise<StoredCall[]> =>
    (((await api!.get(`/conversations/${conversationId}`)).data as { messages: { toolCalls?: StoredCall[] }[] }).messages.at(-1)?.toolCalls ?? []);
  const newChat = async (title: string): Promise<string> => {
    const id = ((await api!.post('/conversations', { title: `${title} ${stamp}` })).data as { id: string }).id;
    conversations.push(id);
    return id;
  };
  const turn = async (conversationId: string | undefined, agent: string, message: string, inputs?: Record<string, unknown>): Promise<string> => {
    const started = await api!.post('/engine/runs', { agent, message, modelId: choice, ...(conversationId ? { conversationId, modelReach: 'handoffs' } : {}), ...(inputs ? { inputs } : {}) });
    assert.equal(started.status, 201, JSON.stringify(started.data));
    const runId = (started.data as { runId: string }).runId;
    turns.push(runId);
    return runId;
  };

  step('a scripted ACP agent is added by hand to the person\'s machine, and the machine finds it ready');
  device = ((await api.get('/mesh/local-agents')).data as Device[]).find((entry) => entry.id === deviceId);
  assert.ok(device?.online, `${device?.name ?? deviceId} is not connected`);
  scratch = await mkdtemp(path.join(tmpdir(), 'machine-chat-live-'));
  const scriptPath = path.join(scratch, 'script.json');
  const toldPath = path.join(scratch, 'told.json');
  const resolvedPath = path.join(scratch, 'resolved.json');
  const script = (turns: AgentScript['turns']): Promise<void> => writeFile(scriptPath, JSON.stringify({ name: 'koala-script', version: '1.0.0', turns } satisfies AgentScript));
  await script([{ steps: [{ echo: true }] }]);
  const agent: ManualAgent = { id: AGENT, title: 'Scripted agent (machine-chat-live)', command: process.execPath, args: ['--import', TSX_LOADER, SCRIPT_AGENT, scriptPath] };
  const added = await api.put(`/mesh/local-agents/${deviceId}/agents`, { agents: [...device.manualAgents.filter((entry) => entry.id !== AGENT), agent] });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  await until(`${AGENT} to be ready on ${device.name}`, async () => {
    const found = ((await api!.get('/mesh/local-agents')).data as Device[]).find((entry) => entry.id === deviceId)?.agents.find((entry) => entry.id === AGENT);
    return found?.state === 'ready' ? true : undefined;
  });
  console.log(`  ${AGENT} is ready on ${device.name}`);

  await script([
    { when: 'Ask research about the label header', steps: [
      { mcp: { server: 'koala', tool: 'research', args: { question: 'Which header goes on the delivery label? (first)' }, follow: true } },
      { say: 'Research has answered.' },
    ] },
    { when: 'delivery label? (first)', steps: [
      { record: toldPath },
      { tool: { id: 'look', title: 'ls', kind: 'execute' }, ask: true, output: 'nothing here yet' },
      { write: { path: 'label.md', content: `${LABEL}\n` } },
      { mcp: { server: 'koala', tool: 'run_in_workspace', args: { command: 'cat label.md' } } },
      { wait: PAST_THE_JOB_CUTOFF_MS },
      { say: `The header is ${LABEL}; it is in label.md.` },
    ] },
    { when: 'Ask research the second question', steps: [
      { mcp: { server: 'koala', tool: 'research', args: { question: 'Which footer goes on the delivery label? (second)' } } },
      { say: 'Research has answered.' },
    ] },
    { when: 'delivery label? (second)', steps: [
      { tool: { id: 'peek', title: 'ls -la', kind: 'execute' }, ask: true, output: 'nothing' },
      { say: 'Nothing to add.' },
    ] },
    { when: 'These files conflict: notes.md', steps: [
      { record: resolvedPath },
      { write: { path: 'notes.md', content: 'What A found.\nWhat B found.\n' } },
      { say: 'Kept both findings.' },
    ] },
    { when: 'Ask research both questions at once', steps: [
      { mcp: [
        { server: 'koala', tool: 'research', args: { question: 'What does the label header say? (fourth A)' }, follow: true },
        { server: 'koala', tool: 'research', args: { question: 'What does the label footer say? (fourth B)' }, follow: true },
      ] },
      { say: 'Both answered.' },
    ] },
    { when: '(fourth A)', steps: [
      { write: { path: 'notes.md', content: 'What A found.\n' } },
      { say: 'A wrote its finding.' },
    ] },
    { when: '(fourth B)', steps: [
      { wait: 45_000 },
      { write: { path: 'notes.md', content: 'What B found.\n' } },
      { say: 'B wrote its finding.' },
    ] },
    { when: 'its own folder (third)', steps: [
      { record: toldPath },
      { mcp: { server: 'koala', tool: 'search_web', args: { query: 'TabbyAPI default port' } } },
      { say: 'Searched.' },
    ] },
    { steps: [{ echo: true }] },
  ]);

  step('a chat in auto mode on the machine hands work to research, which works in the chat\'s workspace on the machine, past the point where a call becomes a job');
  const first = await newChat('Machine chat live, auto mode');
  const switched = await api.put(`/auto-mode/conversations/${first}`, { on: true });
  assert.equal(switched.status, 200, JSON.stringify(switched.data));
  const firstRun = await turn(first, 'koala', 'Ask research about the label header.');
  const firstEvents = await finished(firstRun);
  const research = firstEvents.find((event) => event.type === 'run.started' && event.parentRunId === firstRun);
  assert.ok(research, 'Koala did not hand anything to research');
  const researchEnd = firstEvents.find((event) => event.type === 'run.finished' && event.runId === research.runId);
  assert.equal(researchEnd?.outcome, 'ok', `research ended ${JSON.stringify(researchEnd)}`);
  assert.equal(firstEvents.find((event) => event.type === 'run.finished' && event.runId === firstRun)?.outcome, 'ok');
  const asked = firstEvents.filter((event) => event.type === 'notice' && event.level === 'warn');
  assert.deepEqual(asked, [], `something asked though the chat is in auto mode: ${JSON.stringify(asked)}`);
  const told = JSON.parse(await readFile(toldPath, 'utf8')) as Told;
  assert.ok(told.cwd.startsWith(`${path.join(homedir(), 'koala', 'koala-trees', `conversation-${first}`, 'repo')}@`), `research worked in ${told.cwd}`);
  assert.ok(told.prompt.includes('is a checkout of this conversation\'s documents'), 'research was not told it works a checkout of the conversation\'s documents');
  assert.ok(told.servers.find((server) => server.server === 'koala')?.tools.some((tool) => tool.name === 'run_in_workspace'), 'run_in_workspace was not served');
  const inWorkspace = firstEvents.find((event) => event.runId === research.runId && event.type === 'tool.result' && firstEvents.some((called) => called.callId === event.callId && called.name === 'run_command'));
  assert.equal(inWorkspace?.ok, true, `run_in_workspace did not run: ${JSON.stringify(inWorkspace)}`);
  assert.ok(inWorkspace?.digest?.includes(LABEL), `run_in_workspace did not see label.md: ${inWorkspace?.digest}`);
  const reply = ((await api.get(`/conversations/${first}`)).data as { messages: { content: string }[] }).messages.at(-1)?.content ?? '';
  assert.match(reply, /waited for job [0-9a-f-]{36} \d+ times/, `the research call never became a job the agent waited for: ${reply}`);
  assert.ok(reply.includes(LABEL), `the agent never got research's answer: ${reply}`);
  const label = await api.get(`/documents/${encodeURIComponent(`conversation-${first}`)}`, { params: { path: 'label.md' } });
  assert.equal((label.data as { content?: string }).content, `${LABEL}\n`, `the chat's workspace holds ${JSON.stringify(label.data)}`);
  const saved = (await lastReply(first)).find((call) => call.name === 'research');
  assert.ok(saved?.child, `the saved reply lost research's run: ${JSON.stringify(saved)}`);
  assert.ok(saved.child.steps.some((entry) => entry.name === 'run_command' && entry.ok), 'the saved reply lost research\'s steps');
  const repo = conversationRepoName(first);
  const { stdout: branches } = await run('git', ['-c', 'credential.helper=', '-c', 'core.askPass=', '-c', `http.extraHeader=Authorization: Bearer ${machine.token}`, 'ls-remote', '--heads', `${BASE}/machines/git/${repo}.git`], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', SSH_ASKPASS: '', GIT_ASKPASS: '' } });
  const left = branches.split('\n').filter((line) => line.includes('refs/heads/machine/'));
  assert.deepEqual(left, [], `the machine's work branches were left behind: ${left.join(', ')}`);
  console.log(`  research ${research.runId} worked in ${told.cwd}, ran run_in_workspace, outlived the job cut-off, asked nothing; label.md is in the chat's workspace, ${saved.child.steps.length} steps on the saved reply, ${repo} has main and no machine branch`);

  step('a chat not in auto mode asks before research runs something on the machine, naming the machine, and a decline is answered');
  const second = await newChat('Machine chat live, asking');
  const secondRun = await turn(second, 'koala', 'Ask research the second question.');
  const ask = await until('research to ask', async () => (await events(secondRun)).find((event) => event.type === 'notice' && event.level === 'warn' && event.callId?.startsWith('ext-')));
  assert.ok(ask.message?.includes(`on ${device.name}`), `the ask does not name ${device.name}: ${ask.message}`);
  const declined = await api.post(`/engine/runs/${ask.runId}/approve`, { callId: ask.callId, allowed: false });
  assert.equal(declined.status, 200, JSON.stringify(declined.data));
  const secondEvents = await finished(secondRun);
  const answered = secondEvents.find((event) => event.type === 'tool.result' && event.callId === ask.callId);
  assert.equal(answered?.ok, false, `the declined call was answered ${JSON.stringify(answered)}`);
  assert.equal(secondEvents.find((event) => event.type === 'run.finished' && event.runId === secondRun)?.outcome, 'ok');
  console.log(`  ${ask.runId} asked "${ask.message}", was declined, and the turn ended ok`);

  step('research on the machine with no conversation works in its own folder, its served tools in its sandbox, and no run_in_workspace');
  await rm(toldPath, { force: true });
  const third = await turn(undefined, 'research', 'Look this up in its own folder (third).', { question: 'Look this up in its own folder (third).' });
  const thirdEvents = await finished(third);
  assert.equal(thirdEvents.find((event) => event.type === 'run.finished' && event.runId === third)?.outcome, 'ok', JSON.stringify(thirdEvents.filter((event) => event.type === 'run.finished')));
  const own = JSON.parse(await readFile(toldPath, 'utf8')) as Told;
  assert.ok(!own.cwd.includes('koala-trees'), `research worked in a checkout, ${own.cwd}`);
  assert.ok(own.prompt.includes('The folder you were told to work in is your own'), 'research was not told the folder is its own');
  assert.ok(!own.servers.find((server) => server.server === 'koala')?.tools.some((tool) => tool.name === 'run_in_workspace'), 'run_in_workspace was served with no repository');
  const searched = thirdEvents.find((event) => event.type === 'tool.result' && thirdEvents.some((called) => called.callId === event.callId && called.name === 'search_web'));
  assert.equal(searched?.ok, true, `search_web did not run: ${JSON.stringify(searched)}`);
  console.log(`  research worked in ${own.cwd}, search_web ran for it, and it was offered no run_in_workspace`);

  step('two research hand-offs at once in one chat write the same file; the one whose work comes back second resolves the conflict in its session, and both findings are kept');
  const fourth = await newChat('Machine chat live, together');
  await api.put(`/auto-mode/conversations/${fourth}`, { on: true });
  const fourthRun = await turn(fourth, 'koala', 'Ask research both questions at once.');
  const fourthEvents = await finished(fourthRun);
  const handed = fourthEvents.filter((event) => event.type === 'run.started' && event.parentRunId === fourthRun);
  assert.equal(handed.length, 2, `Koala handed ${handed.length} questions to research`);
  for (const child of handed) {
    const ended = fourthEvents.find((event) => event.type === 'run.finished' && event.runId === child.runId);
    assert.equal(ended?.outcome, 'ok', `${child.runId} ended ${JSON.stringify(ended)}`);
  }
  const resolved = JSON.parse(await readFile(resolvedPath, 'utf8')) as Told;
  assert.ok(resolved.prompt.includes('These files conflict: notes.md'), `the agent was not told what conflicts: ${resolved.prompt.slice(0, 300)}`);
  const notes = await api.get(`/documents/${encodeURIComponent(`conversation-${fourth}`)}`, { params: { path: 'notes.md' } });
  assert.equal((notes.data as { content?: string }).content, 'What A found.\nWhat B found.\n', `the chat's workspace holds ${JSON.stringify(notes.data)}`);
  const kept = fourthEvents.filter((event) => event.type === 'notice' && event.message?.includes('kept as the branch'));
  assert.deepEqual(kept, [], `work was kept aside instead of merged: ${JSON.stringify(kept)}`);
  const { stdout: fourthBranches } = await run('git', ['-c', 'credential.helper=', '-c', 'core.askPass=', '-c', `http.extraHeader=Authorization: Bearer ${machine.token}`, 'ls-remote', '--heads', `${BASE}/machines/git/${conversationRepoName(fourth)}.git`], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', SSH_ASKPASS: '', GIT_ASKPASS: '' } });
  assert.deepEqual(fourthBranches.split('\n').filter((line) => line.includes('refs/heads/machine/')), [], 'the machine\'s work branches were left behind');
  console.log(`  ${handed.map((child) => child.runId.split('-').slice(-2).join('-')).join(' and ')} worked at once; the second was told notes.md conflicts, kept both findings, and the workspace has them`);

  console.log('\nmachine chat live — PASS');
}

async function teardown(): Promise<void> {
  for (const runId of turns) if (api) await api.post(`/running/${runId}/cancel`).catch(() => undefined);
  for (const id of conversations) if (api) await api.delete(`/conversations/${id}`).catch(() => undefined);
  if (api && device) await api.put(`/mesh/local-agents/${device.id}/agents`, { agents: device.manualAgents }).catch(() => undefined);
  await retire?.().catch((err: Error) => console.error(`  what the memory keeper kept could not be retired: ${err.message}`));
  if (scratch) await rm(scratch, { recursive: true, force: true });
  await closeDb?.();
}

main().then(async () => { await teardown(); process.exit(0); }, async (err) => {
  console.error(err);
  await teardown();
  process.exit(1);
});
