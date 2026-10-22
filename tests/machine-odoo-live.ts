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
import { createDatabase } from '../apps/backend/src/platform/lib/db-interface.js';
import { signJWT } from '../apps/backend/src/platform/lib/auth.js';
import { loadKeys } from '../apps/backend/src/platform/lib/keys.js';
import { getTemporalClient } from '../apps/backend/src/platform/lib/temporal-client.js';
import { groveRunWorkflowId } from '../apps/backend/src/engine-host/temporal/contracts.js';
import { ODOO_TREE_TYPE } from '../apps/backend/src/projects/lib/tree-type-seeds.js';
import { projectIdForTree } from '../apps/backend/src/projects/lib/tree-home.js';
import { newReleaseName, releasePlace } from '../apps/backend/src/releases/lib/odoo-release.js';
import { PROBE, PROBE_FILES } from '../apps/backend/src/eval/level2/mechanics.js';
import { GiteaService } from '../apps/backend/src/projects/services/GiteaService.js';
import { InfrastructureService } from '../apps/backend/src/infrastructure/services/InfrastructureService.js';
import type { AgentScript } from '../apps/local-agent/src/acp-script-agent.js';
import { forgetWhatRunsLeft } from './lib/forget-test-runs.js';

const run = promisify(execFile);
const BASE = process.env.MACHINE_ODOO_LIVE_URL ?? 'http://localhost:3001/api';
const AGENT = 'koala-script';
const SCRIPT_AGENT = fileURLToPath(new URL('../apps/local-agent/src/acp-script-agent.ts', import.meta.url));
const TSX_LOADER = new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href;
const KUBECONFIG = '/tmp/kubeconfig-provisioning-lunorica';
const KUBECTL = fileURLToPath(new URL('../bin/kubectl', import.meta.url));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (message: string) => console.log(`\n▶ ${message}`);

const NO_TEST = 'MARK_NO_TEST';
const UNJUDGED = 'MARK_UNJUDGED';
const MET = 'MARK_MET';
const WRITE = 'MARK_WRITE';
const TEST = 'MARK_TEST';
const BROWSER = 'MARK_BROWSER';
const BROWSER_AGAIN = 'MARK_BROWSER_AGAIN';
const VERDICT = 'Question: Does this verdict';

const MODULE_WITHOUT_TEST = Object.entries(PROBE_FILES).filter(([file]) => !file.includes('/tests/'));
const MODULE_TEST = Object.entries(PROBE_FILES).filter(([file]) => file.includes('/tests/'));
const ODOO_CHECK = { command: `odoo-check ${PROBE} addons`, expects: ['odoo-check: PASSED'] };
const BROWSER_CHECK = { e2e: { specs: ['e2e'] } };

interface ManualAgent { id: string; title?: string; command: string; args: string[] }
interface Device { id: string; name: string; online: boolean; agents: { id: string; state: string; reason?: string }[]; manualAgents: ManualAgent[] }
interface Leaf { id: string; title: string; status?: string; branchId: string }
interface Task { id: string; title: string; status: string; leafId?: string; evidence?: string }
interface Proposal { id: string; status: string; leafPlan?: { leafId: string; mode: string; why: string } }
interface Release { id: string; state: string; slot?: string; reason?: string }
interface TurnEvent { type: string; runId?: string; delta?: string; args?: unknown }

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
let retire: (() => Promise<void>) | undefined;

async function main(): Promise<void> {
  const machine = JSON.parse(await readFile(path.join(homedir(), '.config/koala/machine.json'), 'utf8')) as { deviceId: string; token: string };
  const deviceId = process.env.MACHINE_ODOO_DEVICE ?? machine.deviceId;
  const db = createDatabase();
  await db.init();
  closeDb = async () => { await db.close?.(); };
  const owner = (await db.getLocalAgentDevices()).find((entry) => entry.id === deviceId)?.ownerId;
  assert.ok(owner, `there is no machine ${deviceId}`);
  const user = await db.accounts.getUserById(owner);
  assert.ok(user, 'the machine\'s owner is gone');
  api = axios.create({ baseURL: BASE, proxy: false, validateStatus: () => true, headers: { Cookie: `session=${signJWT({ userId: user.id, email: user.email }, loadKeys(process.env).session, 4 * 3600)}` } });
  const http = api;
  const temporal = await getTemporalClient();
  const began = new Date().toISOString();
  retire = async () => {
    step('whatever the memory keeper keeps from this made-up story is retired');
    const runIds = new Set<string>();
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
  };
  const stamp = Date.now().toString(36);
  const choice = `machine:${deviceId}:${AGENT}`;

  const leaves = async (): Promise<Leaf[]> => (await http.get('/leaves')).data as Leaf[];
  const tasksOf = async (leafId: string): Promise<Task[]> => ((await http.get('/engine/tasks')).data as Task[]).filter((task) => task.leafId === leafId);
  const runTreeToEnd = async (): Promise<string> => {
    const started = await until('the tree to start running', async () => {
      const state = (await http.get(`/trees/${treeId}/run`)).data as { state: string; turnId?: string };
      return state.state === 'running' && state.turnId ? state.turnId : undefined;
    });
    const ended = await temporal.workflow.getHandle(groveRunWorkflowId(treeId!)).result() as { outcome?: string; reason?: string };
    console.log(`  run ${started} ended ${ended.outcome ?? JSON.stringify(ended).slice(0, 200)}`);
    return started;
  };
  const saidBy = async (turnId: string, runPart: RegExp): Promise<string> => {
    const log = (await http.get(`/turns/${encodeURIComponent(turnId)}`)).data as { entries: { events: TurnEvent[] }[] };
    return log.entries.flatMap((entry) => entry.events)
      .filter((event) => runPart.test(event.runId ?? '') && event.type === 'content')
      .map((event) => event.delta ?? '').join('');
  };
  const replanCard = async (leafId: string, after: Set<string>): Promise<Proposal> => until('the planner\'s replan card', async () => {
    const plans = (await http.get('/plans', { params: { treeId } })).data as Proposal[];
    return plans.find((plan) => plan.status === 'proposed' && plan.leafPlan?.leafId === leafId && !after.has(plan.id));
  });

  step('a scripted ACP agent is added by hand to the person\'s machine, and the machine finds it ready');
  device = ((await http.get('/mesh/local-agents')).data as Device[]).find((entry) => entry.id === deviceId);
  assert.ok(device?.online, `${device?.name ?? deviceId} is not connected`);
  scratch = await mkdtemp(path.join(tmpdir(), 'machine-odoo-live-'));
  const scriptPath = path.join(scratch, 'script.json');
  let leafId = '';
  const script = (turns: AgentScript['turns']): Promise<void> => writeFile(scriptPath, JSON.stringify({ name: 'koala-script', version: '1.0.0', turns: [
    { when: [VERDICT, MET], steps: [{ say: 'Yes. The verdict says the work meets what was expected.' }] },
    { when: VERDICT, steps: [{ say: 'No. The verdict does not say the work meets what was expected.' }] },
    ...turns,
    { steps: [{ echo: true }] },
  ] } satisfies AgentScript));
  const plan = {
    tree: { name: `Machine Odoo ${stamp}`, type: ODOO_TREE_TYPE, goal: 'A probe module, built by an agent on the person\'s machine, released to a preview.' },
    planDoc: `# Machine Odoo\n\n## Destination\nThe ${PROBE} module installs into Odoo 20, its test passes, and it is previewed in slot b.\n\n## Not yet specified\nNothing.\n\n## Out of scope\nEverything else.\n`,
    branches: [{ title: 'Modules', leaves: [{
      key: 'probe', title: 'Probe module', body: `${PROBE} installs, its test passes and the browser tests pass`, brief: `Write the ${PROBE} module.`,
      tasks: [
        { key: 'write', title: 'Write the probe module', description: `Write ${PROBE} under addons/ with a model and a test.`, role: 'The story itself.', doneMeans: `${WRITE}: odoo-check says PASSED for ${PROBE}, and its test proves the default size`, checks: ODOO_CHECK },
        { key: 'browser', title: 'Check it in a browser', description: 'Run the browser tests against an Odoo with the module.', role: 'The story itself.', doneMeans: `${BROWSER}: its browser tests pass`, dependsOn: ['write'], checks: BROWSER_CHECK },
      ],
    }] }],
  };
  await script([{ when: 'Plan the machine Odoo check', steps: [{ mcp: { server: 'koala', tool: 'propose_plan', args: plan } }, { say: 'Proposed; it waits for your approval.' }] }]);
  const agent: ManualAgent = { id: AGENT, title: 'Scripted agent (machine-odoo-live)', command: process.execPath, args: ['--import', TSX_LOADER, SCRIPT_AGENT, scriptPath] };
  const added = await http.put(`/mesh/local-agents/${deviceId}/agents`, { agents: [...device.manualAgents.filter((entry) => entry.id !== AGENT), agent] });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  await until(`${AGENT} to be ready on ${device.name}`, async () => {
    const found = ((await http.get('/mesh/local-agents')).data as Device[]).find((entry) => entry.id === deviceId)?.agents.find((entry) => entry.id === AGENT);
    if (found && found.state !== 'ready') console.log(`  ${AGENT}: ${found.state}${found.reason ? `, ${found.reason}` : ''}`);
    return found?.state === 'ready' ? true : undefined;
  });
  console.log(`  ${AGENT} is ready on ${device.name}`);

  step('the planner, on the machine, proposes an Odoo tree with one story of two tasks');
  conversationId = ((await http.post('/conversations', { title: `Machine Odoo live ${stamp}` })).data as { id: string }).id;
  const planned = await http.post('/engine/runs', { agent: 'planner', message: 'Plan the machine Odoo check.', conversationId, inputs: { conversationId, goal: plan.tree.goal }, modelId: choice });
  assert.equal(planned.status, 201, JSON.stringify(planned.data));
  const proposal = await until('the plan', async () => {
    const plans = (await http.get('/plans', { params: { conversationId } })).data as Proposal[] | { plans: Proposal[] };
    return (Array.isArray(plans) ? plans : plans.plans).find((entry) => entry.status === 'proposed');
  });

  step('the plan is approved: the tree, its project and its Odoo 20 starter are made; every agent of the tree is put on the machine');
  const approved = await http.post(`/plans/${proposal.id}/approve`);
  assert.ok(approved.status === 200 || approved.status === 202, JSON.stringify(approved.data));
  await temporal.workflow.getHandle(`adopt-plan-${proposal.id}`).result();
  const adopted = (await http.get(`/plans/${proposal.id}`)).data as { status: string; reason?: string; adopted?: { treeId: string; leafIds: Record<string, string> } };
  assert.equal(adopted.status, 'adopted', adopted.reason ?? 'the plan was not adopted');
  treeId = adopted.adopted!.treeId;
  leafId = Object.values(adopted.adopted!.leafIds)[0]!;
  const projectId = projectIdForTree(treeId);
  console.log(`  tree ${treeId}, story ${leafId}, project ${projectId}`);
  await http.post(`/trees/${treeId}/run/stop`, {});
  await temporal.workflow.getHandle(groveRunWorkflowId(treeId)).result().catch(() => undefined);
  const rows = (await http.get(`/trees/${treeId}/models`)).data as { rows: { agent: string }[] };
  for (const row of rows.rows) {
    const set: { status: number; data: unknown } = await http.put(`/trees/${treeId}/models`, { agent: row.agent, modelId: choice });
    assert.equal(set.status, 200, `${row.agent}: ${JSON.stringify(set.data)}`);
  }
  console.log(`  ${rows.rows.map((row) => row.agent).join(', ')} on ${choice}`);

  const seen = new Set<string>();
  step('first attempt: the module is written without a test; odoo-check runs in the workspace; the judge on the machine says not met, and the story fails');
  await script([
    { when: 'Work the task Write the probe module', steps: [
      ...MODULE_WITHOUT_TEST.map(([file, content]) => ({ write: { path: file, content } })),
      { mcp: { server: 'koala', tool: 'run_in_workspace', args: { command: `ls addons/${PROBE}` }, follow: true } },
      { say: `Wrote ${PROBE}.` },
    ] },
    { when: ['record_verdict', WRITE], steps: [{ mcp: { server: 'koala', tool: 'record_verdict', args: { verdict: 'not_met', reasoning: `${NO_TEST}: ${PROBE} has no tests/ folder, so nothing proves its default size` } } }, { say: `Not met: ${NO_TEST}.` }] },
    { when: ['settle_leaf', leafId], steps: [{ mcp: { server: 'koala', tool: 'settle_leaf', args: { leafId, verdict: 'failed', note: `${NO_TEST}: the module was written without its test` } } }, { say: 'Settled: failed.' }] },
    { when: ['propose_leaf_plan', '.failed.md'], steps: [
      { read: { path: `leaves/${leafId}.failed.md` } },
      { mcp: { server: 'koala', tool: 'propose_leaf_plan', args: { leafId, mode: 'replan', why: `${NO_TEST}: the module has no test; add it, then check it in a browser`, brief: `Add the ${PROBE} test; the module is already there.`, tasks: [
        { key: 'test', title: 'Add the probe test', description: `Add tests/ to ${PROBE}.`, role: 'The story itself.', doneMeans: `${TEST}: odoo-check says PASSED for ${PROBE} with its test`, checks: ODOO_CHECK },
        { key: 'browser', title: 'Check it in a browser', description: 'Run the browser tests against an Odoo with the module.', role: 'The story itself.', doneMeans: `${BROWSER}: its browser tests pass`, dependsOn: ['test'], checks: BROWSER_CHECK },
      ] } } },
      { say: 'Proposed a replan.' },
    ] },
  ]);
  const first = await http.post(`/trees/${treeId}/run`, {});
  assert.ok(first.status === 200 || first.status === 202, JSON.stringify(first.data));
  const firstRun = await runTreeToEnd();
  const afterFirst = await tasksOf(leafId);
  const write = afterFirst.find((task) => task.title === 'Write the probe module');
  assert.equal(write?.status, 'failed', `the write task is ${JSON.stringify(write)}`);
  assert.match(write?.evidence ?? '', /does not say the work meets/, `the write task failed for another reason: ${write?.evidence}`);
  assert.equal((await leaves()).find((leaf) => leaf.id === leafId)?.status, 'failed');
  const plannerRead = await saidBy(firstRun, /planner/);
  assert.match(plannerRead, new RegExp(`read: [\\s\\S]*${NO_TEST}`), `the planner's checkout on the machine did not hold the failure: ${plannerRead.slice(0, 400)}`);
  const firstCard = await replanCard(leafId, seen);
  seen.add(firstCard.id);
  assert.match(firstCard.leafPlan!.why, new RegExp(NO_TEST));
  console.log(`  the write task failed on the judge's not met; the planner read leaves/${leafId}.failed.md in its checkout on the machine and proposed ${firstCard.id}`);

  step('second attempt: the test is added and met; the browser task\'s judge ends without a verdict, so that task fails and the story is replanned again');
  await script([
    { when: 'Work the task Add the probe test', steps: [
      ...MODULE_TEST.map(([file, content]) => ({ write: { path: file, content } })),
      { mcp: { server: 'koala', tool: 'run_in_workspace', args: { command: `ls addons/${PROBE}/tests` }, follow: true } },
      { say: `Added the ${PROBE} test.` },
    ] },
    { when: 'Work the task Check it in a browser', steps: [
      { mcp: { server: 'koala', tool: 'run_in_workspace', args: { command: 'ls e2e' }, follow: true } },
      { say: 'The starter\'s browser tests sign in and open the apps.' },
    ] },
    { when: ['record_verdict', TEST], steps: [{ mcp: { server: 'koala', tool: 'record_verdict', args: { verdict: 'met', reasoning: `${MET}: odoo-check passed with the probe test` } } }, { say: `Met: ${MET}.` }] },
    { when: ['record_verdict', BROWSER], steps: [{ say: `${UNJUDGED}: I looked at e2e/ and cannot tell.` }] },
    { when: ['settle_leaf', leafId], steps: [{ mcp: { server: 'koala', tool: 'settle_leaf', args: { leafId, verdict: 'failed', note: `${UNJUDGED}: the browser task was never judged` } } }, { say: 'Settled: failed.' }] },
    { when: ['propose_leaf_plan', '.failed.md'], steps: [
      { read: { path: `leaves/${leafId}.failed.md` } },
      { mcp: { server: 'koala', tool: 'propose_leaf_plan', args: { leafId, mode: 'replan', why: `${UNJUDGED}: the browser task was not judged; check it again`, brief: 'Check the module in a browser.', tasks: [
        { key: 'browser', title: 'Check it in a browser again', description: 'Run the browser tests against an Odoo with the module.', role: 'The story itself.', doneMeans: `${BROWSER_AGAIN}: its browser tests pass`, checks: BROWSER_CHECK },
      ] } } },
      { say: 'Proposed a replan.' },
    ] },
  ]);
  const second = await http.post(`/plans/${firstCard.id}/approve`);
  assert.ok(second.status === 200 || second.status === 202, JSON.stringify(second.data));
  const secondRun = await runTreeToEnd();
  const afterSecond = await tasksOf(leafId);
  const tested = afterSecond.find((task) => task.title === 'Add the probe test');
  assert.equal(tested?.status, 'done', `the test task is ${JSON.stringify(tested)}`);
  const browsed = afterSecond.find((task) => task.title === 'Check it in a browser' && task.status !== 'dropped');
  assert.equal(browsed?.status, 'failed', `a browser task the judge never decided is ${JSON.stringify(browsed)}`);
  assert.doesNotMatch(browsed?.evidence ?? '', new RegExp(MET), 'a task no judge decided was taken as met');
  const plannerReadAgain = await saidBy(secondRun, /planner/);
  assert.match(plannerReadAgain, new RegExp(UNJUDGED), `the planner was not handed why the browser task failed: ${plannerReadAgain.slice(0, 400)}`);
  const secondCard = await replanCard(leafId, seen);
  seen.add(secondCard.id);
  console.log(`  the test task is done; the browser task failed: ${browsed?.evidence?.slice(0, 160)}`);

  step('third attempt: the browser task is met; the leaf judge on the machine verifies the story, and it lands');
  await script([
    { when: 'Work the task Check it in a browser again', steps: [
      { mcp: { server: 'koala', tool: 'run_in_workspace', args: { command: 'ls e2e' }, follow: true } },
      { say: 'The starter\'s browser tests sign in and open the apps.' },
    ] },
    { when: ['record_verdict', BROWSER_AGAIN], steps: [{ mcp: { server: 'koala', tool: 'record_verdict', args: { verdict: 'met', reasoning: `${MET}: the browser tests passed` } } }, { say: `Met: ${MET}.` }] },
    { when: ['settle_leaf', leafId], steps: [{ mcp: { server: 'koala', tool: 'settle_leaf', args: { leafId, verdict: 'verified', note: `${MET}: the module installs, its test passes and the browser tests pass` } } }, { say: 'Settled: verified.' }] },
  ]);
  const third = await http.post(`/plans/${secondCard.id}/approve`);
  assert.ok(third.status === 200 || third.status === 202, JSON.stringify(third.data));
  await runTreeToEnd();
  assert.equal((await leaves()).find((leaf) => leaf.id === leafId)?.status, 'succeeded');

  step(`${PROBE} and its test are on main, and no work branch of the machine's is left`);
  const gitea = new GiteaService(new InfrastructureService(), loadKeys(process.env).data, KUBECONFIG);
  const account = await db.projects.getGiteaAccount(owner);
  const project = (await db.projects.getProjects()).find((entry) => entry.id === projectId);
  assert.ok(project?.giteaRepo, `the tree has no project ${projectId}`);
  const testOnMain = await gitea.getRawFile(account!.username, project.giteaRepo, `addons/${PROBE}/tests/test_probe.py`, 'main');
  assert.match(testOnMain ?? '', /test_default_size/, 'the probe test is not on main');
  const { stdout: branches } = await run('git', ['-c', 'credential.helper=', '-c', 'core.askPass=', '-c', `http.extraHeader=Authorization: Bearer ${machine.token}`, 'ls-remote', '--heads', `${BASE}/machines/git/${project.giteaRepo}.git`], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', SSH_ASKPASS: '', GIT_ASKPASS: '' } });
  const left = branches.split('\n').filter((line) => line.includes('refs/heads/machine/'));
  assert.deepEqual(left, [], `the machine's work branches were left behind: ${left.join(', ')}`);

  step('the starter went live in slot a; the landed story is built and prepared in slot b as a preview with the module installed');
  const releases = async (): Promise<Release[]> => ((await http.get(`/projects/${projectId}/releases`)).data as { releases: Release[] }).releases;
  const failedRelease = (all: Release[]) => all.find((release) => release.state === 'failed');
  const live = await until('the starter to be live', async () => {
    const all = await releases();
    const broken = failedRelease(all);
    if (broken) assert.fail(`a release failed: ${broken.reason}`);
    return all.find((release) => release.state === 'live');
  });
  assert.equal(live.slot, 'a');
  const preview = await until('the landed story\'s preview', async () => {
    const all = await releases();
    const broken = failedRelease(all);
    if (broken) assert.fail(`a release failed: ${broken.reason}`);
    return all.find((release) => release.state === 'preview');
  });
  assert.equal(preview.slot, 'b');
  const named = (await db.projects.getProjects()).find((entry) => entry.id === projectId)!;
  const place = releasePlace(named.releaseName ?? newReleaseName(named));
  const installed = (await run(KUBECTL, ['-n', place.namespace, 'exec', `${place.release}-postgres-0`, '--', 'psql', '-U', 'odoo', '-d', 'odoo_b', '-tAc', `select state from ir_module_module where name = '${PROBE}'`], { env: { ...process.env, KUBECONFIG } })).stdout.trim();
  assert.equal(installed, 'installed', `${PROBE} in the preview is ${installed || 'not there'}`);
  console.log(`  live on slot a; preview ${preview.id} on slot b with ${PROBE} installed`);

  console.log('\nmachine odoo live — PASS');
}

async function teardown(): Promise<void> {
  if (api && treeId) {
    const projectOf = ((await api.get('/projects').catch(() => ({ data: [] }))).data as { id: string; name: string }[])
      .find((project) => project.id === projectIdForTree(treeId!));
    if (projectOf) await api.delete(`/projects/${projectOf.id}`, { data: { confirm: projectOf.name } }).catch(() => undefined);
    else await api.delete(`/trees/${treeId}`).catch(() => undefined);
  }
  if (api && conversationId) await api.delete(`/conversations/${conversationId}`).catch(() => undefined);
  if (api && device) await api.put(`/mesh/local-agents/${device.id}/agents`, { agents: device.manualAgents }).catch(() => undefined);
  await retire?.().catch((err: Error) => console.error(`  the memory keeper's runs could not be retired: ${err.message}`));
  if (scratch) await rm(scratch, { recursive: true, force: true });
  await closeDb?.();
}

main().then(async () => { await teardown(); process.exit(0); }, async (err) => {
  console.error(err);
  await teardown();
  process.exit(1);
});
