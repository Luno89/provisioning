import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)) });
import axios from 'axios';
import { io as connectSocket, type Socket } from 'socket.io-client';
import { signJWT } from '../apps/backend/src/lib/auth.js';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import { loadKeys } from '../apps/backend/src/lib/keys.js';
import { forgetWhatRunsLeft } from './lib/forget-test-runs.js';
import { getTemporalClient } from '../apps/backend/src/lib/temporal-client.js';
import { createKubeRunner } from '../apps/backend/src/engine-host/sandboxes/kube.js';
import { workspaceName } from '../apps/backend/src/engine-host/sandboxes/workspace.js';
import { conversationRepoName, conversationWorkspaceRunId } from '../apps/backend/src/engine-host/sandboxes/workspace-repos.js';
import { GiteaService } from '../apps/backend/src/services/GiteaService.js';
import { InfrastructureService } from '../apps/backend/src/services/InfrastructureService.js';
import { ENDED_UNSAVED } from '../apps/backend/src/services/ConversationTurnService.js';

const BASE = process.env.TURN_LOG_LIVE_URL ?? 'http://localhost:3001/api';
const OWNER = process.env.TURN_LOG_LIVE_OWNER ?? process.env.GROVE_LIVE_OWNER;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(what: string, limitMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(1_000);
  }
}

interface Event { type: string; runId: string; delta?: string; nodeId?: string }
interface Entry { turnId: string; seq: number; events: Event[] }
interface Message { role: string; content: string; runId?: string; interruptedReason?: string; toolCalls?: unknown[] }
interface Conversation { id: string; messages: Message[]; liveTurn?: { runId: string } }

async function main(): Promise<void> {
  assert.ok(OWNER, 'set TURN_LOG_LIVE_OWNER (or GROVE_LIVE_OWNER) to the user whose model the runs use');
  const db = createDatabase();
  await db.init();
  const user = await db.getUserById(OWNER);
  assert.ok(user, 'no such user');
  const session = `session=${signJWT({ userId: user.id, email: user.email }, loadKeys(process.env).session, 7200)}`;
  const http = axios.create({ baseURL: BASE, proxy: false, headers: { Cookie: session } });
  const temporal = await getTemporalClient();
  const kube = createKubeRunner();
  const gitea = new GiteaService(new InfrastructureService(), loadKeys(process.env).data, '/tmp/kubeconfig-provisioning-lunorica');
  const touched = new Set<string>();

  const listen = (): { heard: Entry[]; socket: Socket } => {
    const heard: Entry[] = [];
    const socket = connectSocket(new URL(BASE).origin, { transports: ['websocket'], extraHeaders: { Cookie: session } });
    socket.on('turn-log', (entry: Entry) => { heard.push(entry); });
    return { heard, socket };
  };
  const read = async (turnId: string, after: number): Promise<Entry[]> => ((await http.get(`/turns/${turnId}`, { params: { after } })).data as { entries: Entry[] }).entries;
  const conversation = async (id: string): Promise<Conversation> => (await http.get(`/conversations/${id}`)).data as Conversation;
  const textOf = (entries: Entry[], runId: string) => entries.flatMap((entry) => entry.events).filter((event) => event.runId === runId && event.type === 'content').map((event) => event.delta ?? '').join('');
  const ended = (entries: Entry[], runId: string) => entries.some((entry) => entry.events.some((event) => event.runId === runId && event.type === 'run.finished'));

  const conversationId = (await http.post('/conversations', {})).data.id as string;
  const account = await db.getGiteaAccount(OWNER);
  try {
    console.log('[1/4] a turn is opened on the server before anything runs');
    const first = listen();
    await until('the socket to connect', 30_000, async () => (first.socket.connected ? true : undefined));
    const asked = 'Ask research to find the default TCP port PostgreSQL listens on, then tell me in one sentence.';
    const { runId } = (await http.post('/engine/runs', { agent: 'koala', message: asked, conversationId, inputs: { conversationId } })).data as { runId: string };
    touched.add(runId);
    const opened = await conversation(conversationId);
    console.log(`  run ${runId}; the conversation holds the question (${opened.messages.at(-1)?.runId === runId ? 'tagged with the run' : 'untagged'}) and liveTurn ${opened.liveTurn?.runId ?? 'none'}`);
    assert.deepEqual(opened.messages.map((message) => [message.role, message.content, message.runId]), [['user', asked, runId]]);
    assert.equal(opened.liveTurn?.runId, runId);

    console.log('[2/4] the browser goes away mid-turn, comes back, rebuilds the turn from its log and follows it on');
    await until('the turn to be several entries in', 10 * 60_000, async () => (first.heard.filter((entry) => entry.turnId === runId).length >= 3 ? true : undefined));
    const beforeLeaving = first.heard.filter((entry) => entry.turnId === runId);
    first.socket.close();
    await sleep(15_000);
    const second = listen();
    await until('the socket to connect again', 30_000, async () => (second.socket.connected ? true : undefined));
    const midway = await conversation(conversationId);
    assert.equal(midway.liveTurn?.runId, runId, 'the conversation stopped saying a turn is under way while it still was');
    const caughtUp = await read(runId, 0);
    console.log(`  heard ${beforeLeaving.length} entries before leaving; the log held ${caughtUp.length} on coming back`);
    assert.ok(caughtUp.length > beforeLeaving.length, 'nothing was written while the browser was away, so this did not test catching up');
    assert.deepEqual(caughtUp.slice(0, beforeLeaving.length), beforeLeaving, 'the log does not hold what the browser was told');

    const followed = await until('the turn to end', 30 * 60_000, async () => {
      const seen = new Map<number, Entry>([...caughtUp, ...second.heard.filter((entry) => entry.turnId === runId)].map((entry) => [entry.seq, entry]));
      const ordered = [...seen.values()].sort((a, b) => a.seq - b.seq);
      return ended(ordered, runId) ? ordered : undefined;
    });
    const positions = followed.map((entry) => entry.seq);
    console.log(`  rebuilt and followed ${positions.length} entries, 1 to ${positions.at(-1)}`);
    assert.deepEqual(positions, positions.map((_, index) => index + 1), 'catching up and following left a gap');
    assert.deepEqual(followed, await read(runId, 0), 'what the browser rebuilt differs from the log');
    second.socket.close();

    console.log('[3/4] the saved reply is what the log says the turn said');
    const done = await until('the reply to be saved', 60_000, async () => {
      const found = await conversation(conversationId);
      return found.liveTurn ? undefined : found;
    });
    const reply = done.messages.at(-1)!;
    console.log(`  saved: ${reply.content.slice(0, 160).replace(/\n/g, ' ')}`);
    assert.equal(reply.role, 'assistant');
    assert.equal(reply.runId, runId);
    assert.equal(reply.content, textOf(followed, runId).slice(-reply.content.length), 'the saved reply is not the text the log streamed');
    assert.ok(reply.content.trim(), 'the turn saved an empty reply');

    console.log('[4/4] a run that dies mid-turn leaves what it had done, marked interrupted, rather than nothing');
    const watch = listen();
    const doomed = (await http.post('/engine/runs', { agent: 'koala', message: 'Count slowly from one to two hundred, one number per line.', conversationId, inputs: { conversationId } })).data as { runId: string };
    touched.add(doomed.runId);
    await until('the doomed turn to say something', 5 * 60_000, async () => (textOf(await read(doomed.runId, 0), doomed.runId).length > 40 ? true : undefined));
    await temporal.workflow.getHandle(doomed.runId).terminate('turn-log live test: a run that dies before it saves');
    await sleep(2_000);
    const settled = await conversation(conversationId);
    const salvaged = settled.messages.at(-1)!;
    await sleep(2_000);
    const log = textOf(await read(doomed.runId, 0), doomed.runId);
    console.log(`  the conversation kept ${salvaged.content.length} characters, marked "${salvaged.interruptedReason ?? ''}"; the log holds ${log.length}`);
    assert.equal(settled.liveTurn, undefined, 'the dead turn still reads as under way');
    assert.equal(salvaged.runId, doomed.runId);
    assert.equal(salvaged.interruptedReason, ENDED_UNSAVED);
    assert.ok(salvaged.content.length > 40, 'the kept reply lost what the turn had said');
    assert.ok(log.startsWith(salvaged.content), 'the kept reply is not what the log held');
    assert.ok(watch.heard.length > 0, 'the browser heard nothing of the second turn');
    watch.socket.close();

    console.log('turn log live — PASS');
  } finally {
    await http.delete(`/conversations/${conversationId}`).catch(() => undefined);
    await kube(['delete', 'namespace', workspaceName(conversationWorkspaceRunId(conversationId)), '--ignore-not-found', '--wait=false']);
    if (account) await gitea.deleteRepo(account.username, conversationRepoName(conversationId)).catch(() => undefined);
    console.log(`  forgot ${await forgetWhatRunsLeft(db, OWNER, touched)} things the test's own runs left behind`);
    await db.close();
  }
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
