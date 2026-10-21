import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)) });
import axios, { type AxiosInstance } from 'axios';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import { signJWT } from '../apps/backend/src/lib/auth.js';
import { loadKeys } from '../apps/backend/src/lib/keys.js';
import { getTemporalClient } from '../apps/backend/src/lib/temporal-client.js';
import { workflowOfRun } from '../apps/backend/src/engine-host/temporal/contracts.js';
import { forgetWhatRunsLeft } from './lib/forget-test-runs.js';

const BASE = process.env.FILES_LIVE_URL ?? 'http://localhost:3001/api';
const CLUSTER = 'provisioning-lunorica';
const STAMP = Date.now().toString(36);
const DROP_TYPE = 'application/vnd.koala.drop+json';
const TOKEN = `KOALA-FILES-LIVE-${STAMP.toUpperCase()}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (message: string) => console.log(`\n▶ ${message}`);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

async function until<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
  let last = '';
  for (let tries = 0; ; tries += 1) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (err) {
      last = (err as Error).message;
    }
    if (tries > 0 && tries % 12 === 0) console.log(`  still waiting for ${what}${last ? ` (${last.slice(0, 200)})` : ''}`);
    await sleep(5000);
  }
}

interface Project { id: string; name: string; giteaOwner: string; giteaRepo: string }
interface Server { kind: string; deploymentId: string; name: string }

let api: AxiosInstance | undefined;
let closeDb: (() => Promise<void>) | undefined;
let retire: (() => Promise<void>) | undefined;
const projects: Project[] = [];
const conversations: string[] = [];
let nextcloudId: string | undefined;

const put = (scope: string, path: string, bytes: Buffer, type: string) =>
  api!.put(`/files/${scope}/content`, bytes, { params: { path }, headers: { 'Content-Type': 'application/octet-stream', 'X-File-Type': type }, maxBodyLength: Infinity });
const read = async (scope: string, path: string) => {
  const answer = await api!.get(`/files/${scope}/content`, { params: { path }, responseType: 'arraybuffer' });
  return { status: answer.status, bytes: Buffer.from(answer.data as ArrayBuffer), type: String(answer.headers['content-type']) };
};
const list = async (scope: string, dir = '') => {
  const answer = await api!.get(`/files/${scope}/list`, { params: { dir } });
  assert.equal(answer.status, 200, JSON.stringify(answer.data));
  return answer.data as { name: string; path: string; type: string; size?: number }[];
};

async function newProject(name: string): Promise<Project> {
  const made = await api!.post('/projects', { name, giteaRepo: name, createRepo: true });
  assert.ok(made.status < 300, JSON.stringify(made.data));
  const project = made.data as Project;
  projects.push(project);
  return project;
}

async function deleteProject(project: Project): Promise<void> {
  const removing = await api!.delete(`/projects/${project.id}`, { data: { confirm: project.name } });
  assert.ok(removing.status < 300, JSON.stringify(removing.data));
  await until(`${project.name} to be deleted`, async () => ((await api!.get(`/projects/${project.id}/removal`)).data as { state: string }).state === 'finished' ? true : undefined);
  projects.splice(projects.indexOf(project), 1);
}

async function exercise(scope: string, label: string): Promise<void> {
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255])]);
  const json = Buffer.from('{ "kept" : "exactly as sent" }\n');
  assert.equal((await put(scope, 'docs/brief.pdf', pdf, 'application/pdf')).status, 201);
  assert.equal((await put(scope, 'data.json', json, 'application/json')).status, 201);
  const back = await read(scope, 'docs/brief.pdf');
  assert.equal(back.status, 200);
  assert.equal(sha(back.bytes), sha(pdf), `${label} gave back different bytes`);
  assert.match(back.type, /application\/pdf/);
  assert.equal(sha((await read(scope, 'data.json')).bytes), sha(json), `${label} changed the JSON file`);
  const top = await list(scope);
  assert.deepEqual(top.map((entry) => `${entry.type} ${entry.path}`), ['dir docs', 'file data.json']);
  assert.equal((await api!.post(`/files/${scope}/move`, { from: 'docs', to: 'archive/docs' })).status, 200);
  assert.deepEqual((await list(scope, 'archive/docs')).map((entry) => `${entry.path} ${entry.size}`), [`archive/docs/brief.pdf ${pdf.length}`]);
  assert.equal((await api!.delete(`/files/${scope}/content`, { params: { path: 'data.json' } })).status, 200);
  assert.deepEqual((await list(scope)).map((entry) => entry.path), ['archive']);
  console.log(`  ${label}: a PDF's bytes and a JSON file came back exactly, a folder moved, a file was removed`);
}

async function main(): Promise<void> {
  const db = createDatabase();
  await db.init();
  closeDb = async () => { await db.close?.(); };
  const owner = process.env.FILES_LIVE_OWNER ?? (await db.getDeployments()).find((entry) => entry.appType === 'minio' && entry.status === 'running' && entry.minioRootPassword)?.ownerId;
  assert.ok(owner, 'set FILES_LIVE_OWNER, or run MinIO for someone first');
  const user = await db.getUserById(owner);
  assert.ok(user, 'no such user');
  api = axios.create({ baseURL: BASE, proxy: false, validateStatus: () => true, headers: { Cookie: `session=${signJWT({ userId: user.id, email: user.email }, loadKeys(process.env).session, 4 * 3600)}` } });
  const temporal = await getTemporalClient();
  const runIds = new Set<string>();
  const began = new Date().toISOString();
  retire = async () => {
    for await (const workflow of temporal.workflow.list({ query: `WorkflowId STARTS_WITH "memory-" AND StartTime >= "${began}"` })) runIds.add(workflow.workflowId);
    await forgetWhatRunsLeft(db, owner, new Set([...runIds, ...[...runIds].map((id) => `memory-run-${id}`)]));
  };

  step('the person\'s MinIO is one of their file servers');
  const servers = (await api.get('/files/servers')).data as { servers: Server[] };
  const minio = servers.servers.find((server) => server.kind === 'minio');
  assert.ok(minio, `no MinIO among ${JSON.stringify(servers)}`);
  console.log(`  ${minio.name} (${minio.deploymentId})`);

  step('code dropped on a project\'s repository is committed in one commit, its bytes whole');
  const shop = await newProject(`files-live-${STAMP}`);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);
  const dropped = await api.post(`/projects/${shop.id}/files/drop`, JSON.stringify({ dir: 'public', files: [{ path: 'logo.png', content: png.toString('base64') }, { path: 'notes.md', content: Buffer.from('# Notes\n').toString('base64') }] }), { headers: { 'Content-Type': DROP_TYPE } });
  assert.equal(dropped.status, 201, JSON.stringify(dropped.data));
  assert.deepEqual((dropped.data as { paths: string[] }).paths, ['public/logo.png', 'public/notes.md']);
  const tree = ((await api.get(`/projects/${shop.id}/files`, { params: { path: 'public' } })).data as { entries: { name: string; size?: number }[] }).entries;
  assert.deepEqual(tree.map((entry) => `${entry.name} ${entry.size}`).sort(), [`logo.png ${png.length}`, 'notes.md 8']);
  console.log(`  committed ${(dropped.data as { commit: string }).commit.slice(0, 8)} with logo.png (${png.length} bytes) and notes.md`);

  step('the project keeps its other files on that MinIO');
  assert.deepEqual((await api.get(`/files/projects/${shop.id}/place`)).data, { state: 'none' });
  const chosen = await api.put(`/files/projects/${shop.id}/place`, { deploymentId: minio.deploymentId });
  assert.equal(chosen.status, 200, JSON.stringify(chosen.data));
  await exercise(`projects/${shop.id}`, 'MinIO');

  step('a file attached in the project\'s chat is stored there, and Koala, on the person\'s model, reads it with the files tool');
  const attachment = `attachments/${new Date().toISOString().slice(0, 10)}/live-brief.md`;
  assert.equal((await put(`projects/${shop.id}`, attachment, Buffer.from(`The code word is ${TOKEN}.\n`), 'text/markdown')).status, 201);
  const conversationId = ((await api.post('/conversations', { title: `Files live ${STAMP}`, projectId: shop.id })).data as { id: string }).id;
  conversations.push(conversationId);
  const chat = await api.post('/engine/runs', {
    agent: 'koala',
    conversationId,
    message: 'Read the file I attached and tell me the code word in it, exactly as written.',
    attachments: [{ name: 'live-brief.md', path: attachment, type: 'text/markdown', projectId: shop.id }],
  });
  assert.equal(chat.status, 201, JSON.stringify(chat.data));
  const runId = (chat.data as { runId: string }).runId;
  runIds.add(runId);
  await temporal.workflow.getHandle(workflowOfRun(runId)).result().catch(() => undefined);
  const saved = (await api.get(`/conversations/${conversationId}`)).data as { messages: { role: string; content: string; attachments?: { path: string }[]; toolCalls?: { name: string }[] }[] };
  const asked = saved.messages.find((message) => message.role === 'user');
  assert.deepEqual(asked?.attachments?.map((entry) => entry.path), [attachment], 'the person\'s message keeps what was attached');
  const reply = saved.messages.filter((message) => message.role === 'assistant').at(-1);
  assert.ok(reply?.toolCalls?.some((call) => call.name === 'read_stored_file'), `Koala did not read the file: ${JSON.stringify(reply?.toolCalls?.map((call) => call.name))}`);
  assert.ok(reply?.content.includes(TOKEN), `the reply was ${JSON.stringify(reply?.content)}`);
  console.log(`  Koala called read_stored_file and answered with ${TOKEN}`);

  step('deleting the project deletes its files: a new project of the same name finds its folder empty');
  await deleteProject(shop);
  const again = await newProject(shop.name);
  await api.put(`/files/projects/${again.id}/place`, { deploymentId: minio.deploymentId });
  assert.deepEqual(await list(`projects/${again.id}`), []);
  await deleteProject(again);
  console.log('  nothing of it was left in MinIO');

  step('a Nextcloud deployed for the person gets its own password and keeps a project\'s files over WebDAV');
  const nextcloudName = `files-live-cloud-${STAMP}`;
  const made = await api.post('/deployments', { name: nextcloudName, clusterId: CLUSTER, appType: 'nextcloud', strategy: 'native' });
  assert.ok(made.status < 300, JSON.stringify(made.data));
  nextcloudId = (made.data as { id: string }).id;
  const deployed = (await db.getDeployments()).find((entry) => entry.id === nextcloudId);
  assert.match(deployed?.nextcloudAdminPassword ?? '', /^[0-9a-f]{48}$/, 'Nextcloud got no generated admin password');
  await until('Nextcloud to run and answer', async () => {
    const found = ((await api!.get('/files/servers')).data as { servers: Server[] }).servers.find((server) => server.deploymentId === nextcloudId);
    return found ? true : undefined;
  });
  const blog = await newProject(`files-live-blog-${STAMP}`);
  assert.equal((await api.put(`/files/projects/${blog.id}/place`, { deploymentId: nextcloudId })).status, 200);
  await until('Nextcloud to finish installing', async () => ((await api!.get(`/files/projects/${blog.id}/list`)).status === 200 ? true : undefined));
  await exercise(`projects/${blog.id}`, 'Nextcloud');
  await deleteProject(blog);
  const blogAgain = await newProject(blog.name);
  await api.put(`/files/projects/${blogAgain.id}/place`, { deploymentId: nextcloudId });
  assert.deepEqual(await list(`projects/${blogAgain.id}`), []);
  await deleteProject(blogAgain);
  console.log('  and deleting the project removed its folder from Nextcloud');

  console.log('\nfiles live — PASS');
}

async function teardown(): Promise<void> {
  for (const project of [...projects]) await api?.delete(`/projects/${project.id}`, { data: { confirm: project.name } }).catch(() => undefined);
  for (const id of conversations) await api?.delete(`/conversations/${id}`).catch(() => undefined);
  if (api && nextcloudId) {
    await api.delete(`/deployments/${nextcloudId}`).catch(() => undefined);
    await until('the Nextcloud to go', async () => (((await api!.get('/deployments')).data as { id: string }[]).some((entry) => entry.id === nextcloudId) ? undefined : true)).catch(() => undefined);
    console.log('  the test Nextcloud is destroyed');
  }
  await retire?.().catch((err: Error) => console.error(`  what the memory keeper kept could not be retired: ${err.message}`));
  await closeDb?.();
}

main().then(async () => { await teardown(); process.exit(0); }, async (err) => {
  console.error(err);
  await teardown();
  process.exit(1);
});
