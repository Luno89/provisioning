import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)) });
import axios, { type AxiosInstance } from 'axios';
import { io as connectSocket, type Socket } from 'socket.io-client';
import { signJWT } from '../apps/backend/src/lib/auth.js';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import { loadKeys } from '../apps/backend/src/lib/keys.js';
import { forgetWhatRunsLeft } from './lib/forget-test-runs.js';
import { DEFAULT_CONCLUDE_AFTER_MINUTES } from '../apps/backend/src/lib/conclusions.js';
import { getTemporalClient } from '../apps/backend/src/lib/temporal-client.js';
import { createKubeRunner } from '../apps/backend/src/engine-host/sandboxes/kube.js';
import { POD, workspaceName } from '../apps/backend/src/engine-host/sandboxes/workspace.js';
import { conversationRepoName, conversationWorkspaceRunId } from '../apps/backend/src/engine-host/sandboxes/workspace-repos.js';
import { GiteaService } from '../apps/backend/src/services/GiteaService.js';
import { InfrastructureService } from '../apps/backend/src/services/InfrastructureService.js';

const BASE = process.env.RESEARCH_LIVE_URL ?? 'http://localhost:3001/api';
const OWNER = process.env.RESEARCH_LIVE_OWNER ?? process.env.GROVE_LIVE_OWNER;
const QUIET_MS = DEFAULT_CONCLUDE_AFTER_MINUTES * 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(what: string, limitMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5_000);
  }
}

interface Trace { kind: string; finish?: { outcome: string }; outputs?: { content?: string; results?: { name: string; ok: boolean; digest: string }[] } }

const traces = async (http: AxiosInstance, runId: string): Promise<Trace[]> =>
  ((await http.get(`/engine/runs/${runId}/traces`).catch(() => ({ data: { traces: [] } }))).data.traces as Trace[]) ?? [];

const finished = (http: AxiosInstance, runId: string, limitMs = 30 * 60_000) =>
  until(`run ${runId} to finish`, limitMs, async () => {
    const found = await traces(http, runId);
    return found.some((trace) => trace.finish && trace.kind === 'finish') ? found : undefined;
  });

const calls = (found: Trace[]) => found.filter((trace) => trace.kind === 'run-tool-calls').flatMap((trace) => trace.outputs?.results ?? []);

async function main(): Promise<void> {
  assert.ok(OWNER, 'set RESEARCH_LIVE_OWNER (or GROVE_LIVE_OWNER) to the user whose model the runs use');
  const db = createDatabase();
  await db.init();
  const user = await db.getUserById(OWNER);
  assert.ok(user, 'no such user');
  const http = axios.create({ baseURL: BASE, proxy: false, headers: { Cookie: `session=${signJWT({ userId: user.id, email: user.email }, loadKeys(process.env).session, 7200)}` } });
  const temporal = await getTemporalClient();
  const kube = createKubeRunner();
  const gitea = new GiteaService(new InfrastructureService(), loadKeys(process.env).data, '/tmp/kubeconfig-provisioning-lunorica');
  const touched = new Set<string>();
  const chat = async (conversationId: string, message: string) => {
    const { runId } = (await http.post('/engine/runs', { agent: 'koala', message, conversationId, inputs: { conversationId } })).data as { runId: string };
    touched.add(runId);
    console.log(`  koala run ${runId}`);
    return { runId, traces: await finished(http, runId) };
  };

  const origin = new URL(BASE).origin;
  const listen = (userId: string, email: string) => {
    const heard: { type: string; runId: string; parentRunId?: string; parentCallId?: string; callId?: string; name?: string }[] = [];
    const socket: Socket = connectSocket(origin, { transports: ['websocket'], extraHeaders: { Cookie: `session=${signJWT({ userId, email }, loadKeys(process.env).session, 7200)}` } });
    socket.on('engine-event', (event: (typeof heard)[number]) => { heard.push(event); });
    return { heard, socket };
  };
  const outsiderUser = (await db.getUsers()).find((candidate) => candidate.id !== OWNER);
  assert.ok(outsiderUser, 'there is no second account to check that events stay with their owner');
  const owner = listen(user.id, user.email);
  const outsider = listen(outsiderUser.id, outsiderUser.email);
  await until('both sockets to connect', 30_000, async () => (owner.socket.connected && outsider.socket.connected ? true : undefined));

  const conversationId = (await http.post('/conversations', {})).data.id as string;
  const namespace = workspaceName(conversationWorkspaceRunId(conversationId));
  const repo = conversationRepoName(conversationId);
  const account = await db.getGiteaAccount(OWNER);
  let deleted = false;
  try {
    console.log('[1/5] koala hands three separate questions to research in one reply');
    const first = await chat(conversationId, 'I need three separate facts looked up, each by its own research call, all at once: (1) the year the first version of Node.js was released, (2) the default TCP port PostgreSQL listens on, (3) who created the Python programming language. Then give me one short summary of all three.');
    const koalaCalls = calls(first.traces);
    console.log(`  koala called: ${koalaCalls.map((call) => `${call.name}${call.ok ? '' : ' (failed)'}`).join(', ')}`);

    const children: { id: string; start: number; close: number }[] = [];
    for (let index = 1; ; index += 1) {
      const id = `${first.runId}-research-${index}`;
      const chain: { startTime: Date; closeTime?: Date | undefined }[] = [];
      for await (const execution of temporal.workflow.list({ query: `WorkflowId = '${id}'` })) chain.push(execution);
      if (chain.length === 0) break;
      touched.add(id);
      const start = Math.min(...chain.map((execution) => execution.startTime.getTime()));
      const close = Math.max(...chain.map((execution) => execution.closeTime?.getTime() ?? Date.now()));
      children.push({ id, start, close });
    }
    console.log(`  research runs: ${children.map((child) => `${child.id.slice(-10)} ${Math.round((child.close - child.start) / 1000)}s`).join(', ')}`);
    assert.ok(children.length >= 2, `koala started ${children.length} research runs, not several`);
    const firstReply = first.traces.find((trace) => trace.kind === 'run-tool-calls' && (trace.outputs?.results ?? []).some((call) => call.name === 'research'));
    const batch = children.slice(0, (firstReply?.outputs?.results ?? []).filter((call) => call.name === 'research').length);
    const overlapping = batch.filter((child) => batch.some((other) => other !== child && other.start < child.close && child.start < other.close));
    console.log(`  the first reply asked for ${batch.length}; ${overlapping.length} of them ran at the same time as another`);
    assert.ok(batch.length >= 2, 'koala did not ask for several research runs in one reply');
    assert.equal(overlapping.length, batch.length, 'research runs asked for in the same reply ran one after another');

    console.log('[2/5] they all wrote into the conversation\'s one workspace, each in its own directory');
    const listed = await kube(['exec', POD, '-n', namespace, '--', 'sh', '-c', 'cd /work && find . -type f -not -path "./.git/*" | sort'], undefined, 30_000);
    console.log(`  ${namespace}:\n${listed.stdout.split('\n').map((line) => `    ${line}`).join('\n')}`);
    const reportedOk = calls(first.traces).filter((call) => call.name === 'research' && call.ok).length;
    const succeeded = children.filter((child) => listed.stdout.includes(`./research/${child.id}/`));
    console.log(`  ${succeeded.length} of ${children.length} research runs wrote into their own directory (${reportedOk} reported success)`);
    for (const child of succeeded) {
      assert.ok(listed.stdout.includes(`./research/${child.id}/findings.md`), `${child.id} wrote no findings.md in its directory`);
    }
    assert.ok(succeeded.length >= reportedOk, 'a research run that succeeded wrote nothing in its directory');
    const pods = await kube(['get', 'namespaces', '-o', 'name'], undefined, 15_000);
    const theirOwn = children.filter((child) => pods.stdout.includes(workspaceName(child.id)));
    assert.deepEqual(theirOwn, [], 'a research run got a workspace of its own');

    console.log('[3/5] koala read what they wrote');
    const reads = koalaCalls.filter((call) => call.name === 'read_file' && call.ok);
    console.log(`  koala read ${reads.length} files; it said: ${(first.traces.filter((trace) => trace.kind === 'call-model').at(-1)?.outputs?.content ?? '').slice(0, 300).replace(/\n/g, ' ')}`);
    assert.ok(reads.length >= succeeded.length, 'koala did not read each research run\'s findings');

    console.log('[3b] the chat links each research call to what it wrote, and the links open while the conversation goes on');
    type StoredCall = { name: string; artifacts?: { kind: string; workspace?: string; path?: string }[] };
    const stored = (await http.get(`/conversations/${conversationId}`)).data as { messages: { role: string; toolCalls?: StoredCall[] }[] };
    const researchCalls = stored.messages.filter((message) => message.role === 'assistant').flatMap((message) => message.toolCalls ?? []).filter((call) => call.name === 'research');
    const links = researchCalls.flatMap((call) => call.artifacts ?? []).filter((artifact) => artifact.kind === 'file');
    console.log(`  ${researchCalls.length} research calls carry ${links.length} files: ${links.map((link) => link.path).join(', ')}`);
    const workspace = conversationWorkspaceRunId(conversationId);
    const findingsLinks = succeeded.map((child) => links.find((link) => link.workspace === workspace && link.path === `research/${child.id}/findings.md`));
    assert.ok(findingsLinks.every(Boolean), 'a research call does not link to its findings');
    const opened = new Map<string, string>();
    for (const link of findingsLinks) {
      const document = (await http.get(`/documents/${encodeURIComponent(workspace)}`, { params: { path: link!.path } })).data as { content: string; owner: string; repo: string };
      const inPod = (await kube(['exec', POD, '-n', namespace, '--', 'cat', `/work/${link!.path}`], undefined, 30_000)).stdout;
      assert.equal(document.content, inPod, `${link!.path} opened from Gitea differs from the workspace`);
      opened.set(link!.path!, document.content);
    }
    console.log(`  all ${opened.size} findings open from ${repo} already, matching the workspace`);

    console.log('[3c] each research run showed in the chat while it worked, under the call that started it, and only to its owner');
    type StoredStep = { name: string; ok?: boolean };
    type StoredHandOff = { id: string; name: string; child?: { runId: string; agentId: string; steps: StoredStep[] } };
    const handOffs = (await http.get(`/conversations/${conversationId}`)).data.messages
      .filter((message: { role: string }) => message.role === 'assistant')
      .flatMap((message: { toolCalls?: StoredHandOff[] }) => message.toolCalls ?? [])
      .filter((call: StoredHandOff) => call.name === 'research') as StoredHandOff[];
    const turnEnded = owner.heard.findIndex((event) => event.type === 'run.finished' && event.runId === first.runId);
    assert.ok(turnEnded >= 0, 'the owner\'s browser never heard koala\'s turn end');
    for (const call of handOffs) {
      assert.ok(call.child, `research call ${call.id} was stored without what its run did`);
      const started = owner.heard.findIndex((event) => event.type === 'run.started' && event.runId === call.child!.runId);
      assert.ok(started >= 0, `the browser never heard ${call.child.runId} start`);
      assert.equal(owner.heard[started]!.parentRunId, first.runId);
      assert.equal(owner.heard[started]!.parentCallId, call.id, `${call.child.runId} did not say which call started it`);
      const liveSteps = owner.heard.slice(0, turnEnded).filter((event) => event.runId === call.child!.runId && event.type === 'tool.called').map((event) => event.name);
      console.log(`  ${call.id} → ${call.child.runId.slice(-10)}: ${liveSteps.length} steps heard live before the turn ended; stored ${call.child.steps.length}: ${call.child.steps.map((step) => step.name).join(', ')}`);
      assert.ok(liveSteps.length > 0, `none of ${call.child.runId}'s steps reached the browser before the turn ended`);
      assert.deepEqual(call.child.steps.map((step) => step.name), liveSteps, `${call.child.runId}'s stored steps differ from what the browser saw`);
    }
    assert.ok(handOffs.length > 0, 'no research hand-off was stored');
    console.log(`  the owner's browser heard ${owner.heard.length} events; another account's heard ${outsider.heard.length}`);
    assert.equal(outsider.heard.length, 0, 'another account\'s browser received this run\'s events');
    owner.socket.close();
    outsider.socket.close();

    console.log(`[4/5] after ${QUIET_MS / 60_000} quiet minutes the workspace is saved to ${repo} and deleted`);
    assert.ok(account, 'the owner has no Gitea account');
    await until('the workspace to be saved and deleted', QUIET_MS + 5 * 60_000, async () => {
      const gone = (await kube(['get', 'namespace', namespace, '-o', 'name'], undefined, 15_000)).exitCode !== 0;
      return gone ? true : undefined;
    });
    for (const child of succeeded) {
      const saved = await gitea.getRawFile(account.username, repo, `research/${child.id}/findings.md`, 'main');
      assert.ok(saved, `${child.id}'s findings are not in Gitea`);
    }
    for (const [path, content] of opened) {
      const document = (await http.get(`/documents/${encodeURIComponent(conversationWorkspaceRunId(conversationId))}`, { params: { path } })).data as { content: string };
      assert.equal(document.content, content, `${path} no longer opens the same once the workspace is gone`);
    }
    console.log(`  the chat's links still open the same ${opened.size} files with the pod gone`);
    console.log(`  all ${succeeded.length} findings are in ${account.username}/${repo}, and the pod is gone`);
    const keeper = `memory-conversation-${conversationId}-${(await db.getConversation(OWNER, conversationId))?.messages.length ?? 0}`;
    touched.add(keeper);

    console.log('[5/5] a later turn finds the documents again, and deleting the conversation saves on the same history');
    const later = await chat(conversationId, `Read the findings file of the research run ${succeeded[0]!.id} again and quote its first line to me.`);
    const reread = calls(later.traces).filter((call) => call.name === 'read_file');
    console.log(`  koala read: ${reread.map((call) => `${call.ok ? 'ok' : 'FAILED'} — ${call.digest.slice(0, 120).replace(/\n/g, ' ')}`).join('; ')}`);
    assert.ok(reread.some((call) => call.ok), 'the restored workspace did not hold the earlier findings');
    const removal = await http.delete(`/conversations/${conversationId}`);
    deleted = true;
    assert.equal(removal.status, 200, 'deleting the conversation could not save its workspace');
    await until('the workspace to go with its conversation', 3 * 60_000, async () =>
      ((await kube(['get', 'namespace', namespace, '-o', 'name'], undefined, 15_000)).exitCode !== 0 ? true : undefined));
    console.log('research live — PASS');
  } finally {
    if (!deleted) await http.delete(`/conversations/${conversationId}`).catch(() => undefined);
    await kube(['delete', 'namespace', namespace, '--ignore-not-found', '--wait=false']);
    if (account) await gitea.deleteRepo(account.username, repo).catch(() => undefined);
    console.log(`  forgot ${await forgetWhatRunsLeft(db, OWNER, touched)} things the test's own runs left behind`);
    await db.close();
  }
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
