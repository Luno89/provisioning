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
import { groveRunWorkflowId } from '../apps/backend/src/engine-host/temporal/contracts.js';
import { CATCH_ALL_TREE_TYPE } from '../apps/backend/src/lib/tree-type-seeds.js';
import { GiteaService } from '../apps/backend/src/services/GiteaService.js';
import { InfrastructureService } from '../apps/backend/src/services/InfrastructureService.js';
import type { AgentScript } from '../apps/local-agent/src/acp-script-agent.js';
import { forgetWhatRunsLeft } from './lib/forget-test-runs.js';

const run = promisify(execFile);
const BASE = process.env.MACHINE_STORY_LIVE_URL ?? 'http://localhost:3001/api';
const AGENT = 'koala-script';
const SCRIPT_AGENT = fileURLToPath(new URL('../apps/local-agent/src/acp-script-agent.ts', import.meta.url));
const TSX_LOADER = new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href;
const LABEL = 'Axial Concepts';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (message: string) => console.log(`\n▶ ${message}`);

interface ManualAgent { id: string; title?: string; command: string; args: string[] }
interface Device { id: string; name: string; online: boolean; agents: { id: string; state: string; reason?: string }[]; manualAgents: ManualAgent[] }
interface Leaf { id: string; title: string; state?: string; status?: string; branchId: string }

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
let conversationId: string | undefined;
let treeId: string | undefined;
let closeDb: (() => Promise<void>) | undefined;

async function main(): Promise<void> {
  const machine = JSON.parse(await readFile(path.join(homedir(), '.config/koala/machine.json'), 'utf8')) as { deviceId: string; token: string };
  const deviceId = process.env.MACHINE_STORY_DEVICE ?? machine.deviceId;
  const db = createDatabase();
  await db.init();
  closeDb = async () => { await db.close?.(); };
  const owner = (await db.getLocalAgentDevices()).find((entry) => entry.id === deviceId)?.ownerId;
  assert.ok(owner, `there is no machine ${deviceId}`);
  const user = await db.getUserById(owner);
  assert.ok(user, 'the machine\'s owner is gone');
  api = axios.create({ baseURL: BASE, proxy: false, validateStatus: () => true, headers: { Cookie: `session=${signJWT({ userId: user.id, email: user.email }, loadKeys(process.env).session, 7200)}` } });
  const temporal = await getTemporalClient();
  const began = new Date().toISOString();
  const stamp = Date.now().toString(36);
  const choice = `machine:${deviceId}:${AGENT}`;

  step('a scripted ACP agent is added by hand to the person\'s machine, and the machine finds it ready');
  device = ((await api.get('/mesh/local-agents')).data as Device[]).find((entry) => entry.id === deviceId);
  assert.ok(device?.online, `${device?.name ?? deviceId} is not connected`);
  scratch = await mkdtemp(path.join(tmpdir(), 'machine-story-live-'));
  const scriptPath = path.join(scratch, 'script.json');
  const script = (turns: AgentScript['turns']): Promise<void> => writeFile(scriptPath, JSON.stringify({ name: 'koala-script', version: '1.0.0', turns } satisfies AgentScript));
  const plan = {
    tree: { name: `Machine story ${stamp}`, type: CATCH_ALL_TREE_TYPE, goal: 'A delivery label, written by an agent on the person\'s machine.' },
    planDoc: '# Machine story\n\n## Destination\nlabel.txt on main, holding the label\'s header.\n\n## Not yet specified\nNothing.\n\n## Out of scope\nEverything else.\n',
    branches: [{ title: 'Label', leaves: [{
      key: 'label', title: 'The delivery label', body: `label.txt holds "${LABEL}"`, brief: `Write label.txt with the header ${LABEL}.`,
      tasks: [{ key: 'write', title: 'Write the label', description: `Create label.txt saying ${LABEL}.`, role: 'The story itself.', doneMeans: `label.txt says ${LABEL}`, checks: { command: `grep -q "${LABEL}" label.txt` } }],
    }] }],
  };
  await script([
    { when: 'Plan the machine story check', steps: [{ mcp: { server: 'koala', tool: 'propose_plan', args: plan } }, { say: 'Proposed; it waits for your approval.' }] },
    { steps: [{ echo: true }] },
  ]);
  const agent: ManualAgent = { id: AGENT, title: 'Scripted agent (machine-story-live)', command: process.execPath, args: ['--import', TSX_LOADER, SCRIPT_AGENT, scriptPath] };
  const added = await api.put(`/mesh/local-agents/${deviceId}/agents`, { agents: [...device.manualAgents.filter((entry) => entry.id !== AGENT), agent] });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  await until(`${AGENT} to be ready on ${device.name}`, async () => {
    const found = ((await api!.get('/mesh/local-agents')).data as Device[]).find((entry) => entry.id === deviceId)?.agents.find((entry) => entry.id === AGENT);
    if (found && found.state !== 'ready') console.log(`  ${AGENT}: ${found.state}${found.reason ? `, ${found.reason}` : ''}`);
    return found?.state === 'ready' ? true : undefined;
  });
  console.log(`  ${AGENT} is ready on ${device.name}`);

  step('the planner, on the machine, proposes a one-story tree through Koala\'s propose_plan');
  conversationId = ((await api.post('/conversations', { title: `Machine story live ${stamp}` })).data as { id: string }).id;
  const planned = await api.post('/engine/runs', { agent: 'planner', message: 'Plan the machine story check.', conversationId, inputs: { conversationId, goal: plan.tree.goal }, modelId: choice });
  assert.equal(planned.status, 201, JSON.stringify(planned.data));
  const plannerRun = (planned.data as { runId: string }).runId;
  const proposal = await until('the plan', async () => {
    const plans = (await api!.get('/plans', { params: { conversationId } })).data as { id: string; status: string }[] | { plans: { id: string; status: string }[] };
    return (Array.isArray(plans) ? plans : plans.plans).find((entry) => entry.status === 'proposed');
  });
  console.log(`  planner run ${plannerRun} proposed plan ${proposal.id}`);

  step('the plan is approved, and the tree is made');
  const approved = await api.post(`/plans/${proposal.id}/approve`);
  assert.ok(approved.status === 200 || approved.status === 202, JSON.stringify(approved.data));
  await temporal.workflow.getHandle(`adopt-plan-${proposal.id}`).result();
  const adopted = (await api.get(`/plans/${proposal.id}`)).data as { status: string; reason?: string; adopted?: { treeId: string; leafIds: Record<string, string> } };
  assert.equal(adopted.status, 'adopted', adopted.reason);
  treeId = adopted.adopted!.treeId;
  const leafId = Object.values(adopted.adopted!.leafIds)[0]!;
  console.log(`  tree ${treeId}, story ${leafId}`);
  const first = temporal.workflow.getHandle(groveRunWorkflowId(treeId));
  await api.post(`/trees/${treeId}/run/stop`, {});
  await first.result().catch(() => undefined);
  const waiting = ((await api.get('/leaves')).data as Leaf[]).find((entry) => entry.id === leafId);
  console.log(`  the run approving starts was stopped before its agents were moved; the story is ${waiting?.state ?? waiting?.status}`);

  step('every agent in the tree\'s work is put on the machine for this tree');
  const rows = (await api.get(`/trees/${treeId}/models`)).data as { rows: { agent: string; noMachine?: true }[] };
  for (const row of rows.rows) {
    const set: { status: number; data: unknown } = await api.put(`/trees/${treeId}/models`, { agent: row.agent, modelId: choice });
    assert.equal(set.status, 200, `${row.agent}: ${JSON.stringify(set.data)}`);
  }
  console.log(`  ${rows.rows.map((row) => row.agent).join(', ')} on ${choice}`);
  await script([
    { when: 'Work the task Write the label', steps: [
      { write: { path: 'label.txt', content: `${LABEL}\n` } },
      { mcp: { server: 'koala', tool: 'run_in_workspace', args: { command: 'cat label.txt' } } },
      { say: `Wrote label.txt; in the workspace it reads ${LABEL}.` },
    ] },
    { when: 'Question: Does this verdict', steps: [{ say: 'Yes. The verdict says the work meets what was expected.' }] },
    { when: 'expected: ', steps: [{ mcp: { server: 'koala', tool: 'record_verdict', args: { verdict: 'met', reasoning: `label.txt says ${LABEL}, as expected` } } }, { say: `Met: label.txt says ${LABEL}.` }] },
    { when: leafId, steps: [{ mcp: { server: 'koala', tool: 'settle_leaf', args: { leafId, verdict: 'verified', note: 'scripted judge on the machine' } } }, { say: 'Settled: verified.' }] },
    { steps: [{ echo: true }] },
  ]);

  step('the tree runs: the story is worked on the machine, checked in the workspace, judged and landed');
  const launched = await api.post(`/trees/${treeId}/run`, {});
  assert.ok(launched.status === 200 || launched.status === 202, JSON.stringify(launched.data));
  const grove = await temporal.workflow.getHandle(groveRunWorkflowId(treeId)).result() as { outcome?: string; reason?: string };
  console.log(`  the tree's run ended ${grove.outcome ?? JSON.stringify(grove).slice(0, 200)}`);
  const leaf = ((await api.get('/leaves')).data as Leaf[]).find((entry) => entry.id === leafId);
  console.log(`  the story is ${leaf?.state ?? leaf?.status}`);
  assert.match(String(leaf?.state ?? leaf?.status), /verified|landed|done/, `the story ended ${JSON.stringify(leaf)}`);

  step(`label.txt is on main, as the machine wrote it`);
  const gitea = new GiteaService(new InfrastructureService(), loadKeys(process.env).data, '/tmp/kubeconfig-provisioning-lunorica');
  const account = await db.getGiteaAccount(owner);
  const tree = (await db.getTrees()).find((entry) => entry.id === treeId);
  const projects = await db.getProjects();
  const repo = projects.find((project) => tree?.projectIds?.includes(project.id))?.giteaRepo ?? `tree-${treeId}`;
  const onMain = await gitea.getRawFile(account!.username, repo, 'label.txt', 'main');
  assert.equal(onMain, `${LABEL}\n`, `main holds ${JSON.stringify(onMain)}`);
  const { stdout: branches } = await run('git', ['-c', 'credential.helper=', '-c', 'core.askPass=', '-c', `http.extraHeader=Authorization: Bearer ${machine.token}`, 'ls-remote', '--heads', `${BASE}/machines/git/${repo}.git`], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', SSH_ASKPASS: '', GIT_ASKPASS: '' } });
  const left = branches.split('\n').filter((line) => line.includes('refs/heads/machine/'));
  assert.deepEqual(left, [], `the machine's work branches were left behind: ${left.join(', ')}`);
  console.log(`  ${account!.username}/${repo} main: label.txt = ${JSON.stringify(onMain)}; no work branch of the machine's is left`);

  step('whatever the memory keeper keeps from this made-up story is retired');
  const runIds = new Set<string>([plannerRun]);
  await until('the memory keeper to finish', async () => {
    let running = false;
    for await (const workflow of temporal.workflow.list({ query: `WorkflowId STARTS_WITH "memory-" AND StartTime >= "${began}"` })) {
      runIds.add(workflow.workflowId);
      if (workflow.status.name === 'RUNNING') running = true;
    }
    return running ? undefined : true;
  });
  const forgotten = await forgetWhatRunsLeft(db, owner, runIds);
  console.log(`  ${forgotten} kept thing${forgotten === 1 ? '' : 's'} retired`);

  console.log('\nmachine story live — PASS');
}

async function teardown(): Promise<void> {
  if (api && treeId) await api.delete(`/trees/${treeId}`).catch(() => undefined);
  if (api && conversationId) await api.delete(`/conversations/${conversationId}`).catch(() => undefined);
  if (api && device) await api.put(`/mesh/local-agents/${device.id}/agents`, { agents: device.manualAgents }).catch(() => undefined);
  if (scratch) await rm(scratch, { recursive: true, force: true });
  await closeDb?.();
}

main().then(async () => { await teardown(); process.exit(0); }, async (err) => {
  console.error(err);
  await teardown();
  process.exit(1);
});
