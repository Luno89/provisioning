import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)) });
import axios, { type AxiosInstance } from 'axios';
import { createDatabase } from '../apps/backend/src/platform/lib/db-interface.js';
import { signJWT } from '../apps/backend/src/platform/lib/auth.js';
import { loadKeys } from '../apps/backend/src/platform/lib/keys.js';
import { getTemporalClient } from '../apps/backend/src/platform/lib/temporal-client.js';
import { workflowOfRun } from '../apps/backend/src/engine-host/temporal/contracts.js';
import type { AgentScript } from '../apps/local-agent/src/acp-script-agent.js';
import { forgetWhatRunsLeft } from './lib/forget-test-runs.js';

const BASE = process.env.MACHINE_DEFAULT_LIVE_URL ?? 'http://localhost:3001/api';
const AGENT = 'koala-default-script';
const SCRIPT_AGENT = fileURLToPath(new URL('../apps/local-agent/src/acp-script-agent.ts', import.meta.url));
const TSX_LOADER = new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href;
const ANSWER = 'Answered on the machine, as the account default.';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (message: string) => console.log(`\n▶ ${message}`);

interface ManualAgent { id: string; title?: string; command: string; args: string[] }
interface Device { id: string; name: string; online: boolean; agents: { id: string; state: string }[]; manualAgents: ManualAgent[] }
interface TurnEvent { type: string; runId: string; outcome?: string; reason?: string }

let api: AxiosInstance | undefined;
let device: Device | undefined;
let scratch: string | undefined;
let previousDefault: string | null | undefined;
const conversations: string[] = [];
let closeDb: (() => Promise<void>) | undefined;
let retire: (() => Promise<void>) | undefined;

async function main(): Promise<void> {
  const machine = JSON.parse(await readFile(path.join(homedir(), '.config/koala/machine.json'), 'utf8')) as { deviceId: string };
  const deviceId = process.env.MACHINE_DEFAULT_DEVICE ?? machine.deviceId;
  const db = createDatabase();
  await db.init();
  closeDb = async () => { await db.close?.(); };
  const owner = (await db.getLocalAgentDevices()).find((entry) => entry.id === deviceId)?.ownerId;
  assert.ok(owner, `there is no machine ${deviceId}`);
  const user = await db.accounts.getUserById(owner);
  assert.ok(user, 'the machine\'s owner is gone');
  api = axios.create({ baseURL: BASE, proxy: false, validateStatus: () => true, headers: { Cookie: `session=${signJWT({ userId: user.id, email: user.email }, loadKeys(process.env).session, 3600)}` } });
  const temporal = await getTemporalClient();
  const runIds = new Set<string>();
  const began = new Date().toISOString();
  retire = async () => {
    for await (const workflow of temporal.workflow.list({ query: `WorkflowId STARTS_WITH "memory-" AND StartTime >= "${began}"` })) runIds.add(workflow.workflowId);
    await forgetWhatRunsLeft(db, owner, new Set([...runIds, ...[...runIds].map((id) => `memory-run-${id}`)]));
  };
  const finished = async (runId: string): Promise<TurnEvent[]> => {
    runIds.add(runId);
    await temporal.workflow.getHandle(workflowOfRun(runId)).result().catch(() => undefined);
    return ((await api!.get(`/turns/${runId}`)).data as { entries: { events: TurnEvent[] }[] }).entries.flatMap((entry) => entry.events);
  };

  step('a scripted ACP agent is added to the person\'s machine and found ready');
  device = ((await api.get('/mesh/local-agents')).data as Device[]).find((entry) => entry.id === deviceId);
  assert.ok(device?.online, `${device?.name ?? deviceId} is not connected`);
  scratch = await mkdtemp(path.join(tmpdir(), 'machine-default-live-'));
  const scriptPath = path.join(scratch, 'script.json');
  await writeFile(scriptPath, JSON.stringify({ name: AGENT, version: '1.0.0', turns: [{ steps: [{ say: ANSWER }] }] } satisfies AgentScript));
  const agent: ManualAgent = { id: AGENT, title: 'Scripted agent (machine-default-live)', command: process.execPath, args: ['--import', TSX_LOADER, SCRIPT_AGENT, scriptPath] };
  const added = await api.put(`/mesh/local-agents/${deviceId}/agents`, { agents: [...device.manualAgents.filter((entry) => entry.id !== AGENT), agent] });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  for (;;) {
    const found = ((await api.get('/mesh/local-agents')).data as Device[]).find((entry) => entry.id === deviceId)?.agents.find((entry) => entry.id === AGENT);
    if (found?.state === 'ready') break;
    await sleep(3000);
  }

  step('the agent on the machine becomes the account default, and a machine that is not theirs is refused');
  previousDefault = ((await api.get('/models/default')).data as { defaultModelId: string | null }).defaultModelId;
  const choice = `machine:${deviceId}:${AGENT}`;
  const set = await api.put('/models/default', { modelId: choice });
  assert.equal(set.status, 200, JSON.stringify(set.data));
  assert.equal(((await api.get('/models/default')).data as { defaultModelId: string }).defaultModelId, choice);
  const refused = await api.put('/models/default', { modelId: `machine:not-a-machine:${AGENT}` });
  assert.equal(refused.status, 400, JSON.stringify(refused.data));
  console.log(`  the default is ${choice}; another machine was refused: ${(refused.data as { error: string }).error}`);

  step('a chat turn with no model picked runs on the machine and answers from it');
  const conversationId = ((await api.post('/conversations', { title: `Machine default ${Date.now().toString(36)}` })).data as { id: string }).id;
  conversations.push(conversationId);
  const chat = await api.post('/engine/runs', { agent: 'koala', message: 'Where do you answer from?', conversationId });
  assert.equal(chat.status, 201, JSON.stringify(chat.data));
  const chatEvents = await finished((chat.data as { runId: string }).runId);
  const chatEnded = chatEvents.find((event) => event.type === 'run.finished' && event.runId === (chat.data as { runId: string }).runId);
  assert.equal(chatEnded?.outcome, 'ok', `the chat turn ended ${JSON.stringify(chatEnded)}`);
  const reply = ((await api.get(`/conversations/${conversationId}`)).data as { messages: { role: string; content: string }[] }).messages.filter((message) => message.role === 'assistant').at(-1);
  assert.ok(reply?.content.includes(ANSWER), `the reply was ${JSON.stringify(reply?.content)}`);
  console.log(`  it answered: ${ANSWER}`);

  step('work that cannot be handed to a machine is told plainly to add a model');
  const single = await api.post('/engine/runs', { agent: 'koala', procedure: 'single-shot', message: 'Say hello.' });
  assert.equal(single.status, 201, JSON.stringify(single.data));
  const singleEvents = await finished((single.data as { runId: string }).runId);
  const singleEnded = singleEvents.find((event) => event.type === 'run.finished' && event.runId === (single.data as { runId: string }).runId);
  assert.equal(singleEnded?.outcome, 'failed', `it ended ${JSON.stringify(singleEnded)}`);
  assert.match(singleEnded?.reason ?? '', /Your default is an agent on your machine, and this work cannot be handed to a machine/);
  console.log(`  it failed saying: ${singleEnded?.reason}`);

  console.log('\nmachine default live — PASS');
}

async function teardown(): Promise<void> {
  if (api && previousDefault !== undefined) {
    const restored = await api.put('/models/default', { modelId: previousDefault }).catch((err: Error) => ({ status: 0, data: err.message }));
    console.log(restored.status === 200 ? `  the default is back to ${previousDefault ?? 'none'}` : `  THE DEFAULT COULD NOT BE PUT BACK to ${previousDefault}: ${JSON.stringify(restored.data)}`);
  }
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
