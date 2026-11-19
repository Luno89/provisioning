import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)), quiet: true });
import axios, { type AxiosInstance } from 'axios';
import { devKoalaApi, devKoalaDatabase, devKoalaTemporal, devOwner } from './lib/dev-stack.js';
import { workflowOfRun } from '../apps/backend/src/engine-host/temporal/contracts.js';
import { forgetWhatRunsLeft } from './lib/forget-test-runs.js';
import { DROP_TYPE, dropBody } from '../apps/backend/src/files/lib/drops.js';
import { until, waiting } from './lib/until.js';

const BASE = process.env.FILES_LIVE_URL ?? `${devKoalaApi}/api`;
const STAMP = Date.now().toString(36);
const TOKEN = `KOALA-FILES-LIVE-${STAMP.toUpperCase()}`;
const step = (message: string) => console.log(`\n▶ ${message}`);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

interface Project { id: string; name: string; giteaOwner: string; giteaRepo: string }

let api: AxiosInstance | undefined;
let closeDb: (() => Promise<void>) | undefined;
let retire: (() => Promise<void>) | undefined;
const projects: Project[] = [];
const conversations: string[] = [];

const put = (scope: string, path: string, bytes: Buffer, type: string, replace = false) =>
  api!.put(`/files/${scope}/content`, bytes, { params: { path, ...(replace ? { replace: '1' } : {}) }, headers: { 'Content-Type': 'application/octet-stream', 'X-File-Type': type }, maxBodyLength: Infinity });
const stored = async (scope: string, path: string, bytes: Buffer, type: string, replace = false): Promise<string> => {
  const answer = await put(scope, path, bytes, type, replace);
  assert.equal(answer.status, 201, JSON.stringify(answer.data));
  const body = answer.data as { path: string; id: string };
  assert.equal(body.path, path);
  assert.equal(typeof body.id, 'string', `the upload named no stored file: ${JSON.stringify(body)}`);
  return body.id;
};
const opens = async (link: string) => {
  const answer = await axios.get(link, { proxy: false, responseType: 'arraybuffer', validateStatus: () => true });
  return { status: answer.status, bytes: Buffer.from(answer.data as ArrayBuffer), headers: answer.headers };
};
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
  await until(`${project.name} to be deleted`, async () => {
    const answer = await api!.get(`/projects/${project.id}/removal`);
    if (answer.status === 404) return true;
    const state = (answer.data as { state?: { state: string; reason?: string } }).state;
    return state?.state === 'finished' ? true : waiting(`the removal is ${state?.state ?? 'not reported'}`);
  }, async () => {
    const state = ((await api!.get(`/projects/${project.id}/removal`)).data as { state?: { state: string; reason?: string } }).state;
    return state?.state === 'failed' ? `deleting ${project.name} failed: ${state.reason}` : undefined;
  });
  projects.splice(projects.indexOf(project), 1);
}

async function exercise(scope: string, label: string): Promise<void> {
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255])]);
  const json = Buffer.from('{ "kept" : "exactly as sent" }\n');
  const pdfId = await stored(scope, 'docs/brief.pdf', pdf, 'application/pdf');
  await stored(scope, 'data.json', json, 'application/json');
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
  assert.equal((await read(scope, 'data.json')).status, 404, 'a removed file still opens');
  console.log(`  ${label}: a PDF's bytes and a JSON file came back exactly, a folder moved, a file was removed`);

  assert.equal((await api!.post(`/files/${scope}/folder`, { path: 'invoices' })).status, 201);
  assert.deepEqual((await list(scope)).map((entry) => `${entry.type} ${entry.path}`), ['dir archive', 'dir invoices']);
  assert.deepEqual(await list(scope, 'invoices'), []);
  const found = (await api!.get(`/files/${scope}/search`, { params: { q: 'BRIEF' } })).data as { path: string }[];
  assert.deepEqual(found.map((entry) => entry.path), ['archive/docs/brief.pdf']);
  console.log('  an empty folder was made and listed, and a search found the PDF in a folder two down');
  const room = await api!.get('/files/room');
  assert.equal(room.status, 200, JSON.stringify(room.data));
  assert.ok((room.data as { free: number }).free > 0, 'the instance says it has no room');
  const batch = await api!.post(`/files/${scope}/drop`, dropBody({ dir: 'batch', replace: false }, [{ path: 'one.txt', bytes: Buffer.from('one') }, { path: 'two/three.txt', bytes: Buffer.from('three') }]), { headers: { 'Content-Type': DROP_TYPE } });
  assert.equal(batch.status, 201, JSON.stringify(batch.data));
  assert.deepEqual((batch.data as { files: { path: string }[] }).files.map((file) => file.path).sort(), ['batch/one.txt', 'batch/two/three.txt']);
  const again = await api!.post(`/files/${scope}/drop`, dropBody({ dir: 'batch', replace: false }, [{ path: 'one.txt', bytes: Buffer.from('uno') }, { path: 'four.txt', bytes: Buffer.from('four') }]), { headers: { 'Content-Type': DROP_TYPE } });
  assert.equal(again.status, 409, 'a drop replaced a file without the person being asked');
  assert.deepEqual((again.data as { exists: string[] }).exists, ['batch/one.txt']);
  const listedBatch = await api!.get(`/files/${scope}/list`, { params: { dir: 'batch' } });
  assert.deepEqual((listedBatch.data as { name: string }[]).map((entry) => entry.name).sort(), ['one.txt', 'two'], 'a refused drop kept some of its files');
  console.log('  the room left was told, a drop of two files was kept as one, and a drop over a file already there was refused whole, naming it');

  const share = await api!.post(`/files/${scope}/shares`, { path: 'archive/docs/brief.pdf', days: 1 });
  assert.equal(share.status, 201, JSON.stringify(share.data));
  const link = `${BASE}/share/${(share.data as { token: string }).token}`;
  const stranger = await opens(link);
  assert.equal(stranger.status, 200, 'the link did not open signed out');
  assert.equal(sha(stranger.bytes), sha(pdf));
  const newer = Buffer.concat([pdf, Buffer.from('\n% a second version\n')]);
  const unasked = await put(scope, 'archive/docs/brief.pdf', newer, 'application/pdf');
  assert.equal(unasked.status, 409, 'a file was replaced without the person being asked');
  assert.deepEqual((unasked.data as { exists?: boolean }).exists, true);
  assert.equal(await stored(scope, 'archive/docs/brief.pdf', newer, 'application/pdf', true), pdfId, 'a new version at the same path became another file');
  const followed = await opens(link);
  assert.equal(followed.status, 200, 'the link stopped when its file got a new version');
  assert.equal(sha(followed.bytes), sha(newer), 'the link gave the old version');
  assert.equal((await api!.post(`/files/${scope}/move`, { from: 'archive/docs/brief.pdf', to: 'archive/brief.pdf' })).status, 200);
  assert.equal((await opens(link)).status, 404, 'the link still opened once its file was moved');
  assert.equal((await api!.post(`/files/${scope}/move`, { from: 'archive/brief.pdf', to: 'archive/docs/brief.pdf' })).status, 200);
  assert.equal((await opens(link)).status, 404, 'moving the file back brought its link back');
  console.log('  a link to the PDF opened with no session at all, gave its bytes, followed it to a new version, and stopped once the file moved');

  const revoked = await api!.post(`/files/${scope}/shares`, { path: 'archive/docs/brief.pdf', days: 1 });
  const revokedLink = `${BASE}/share/${(revoked.data as { token: string }).token}`;
  assert.equal((await opens(revokedLink)).status, 200, 'a fresh link did not open');
  assert.equal((await api!.delete(`/files/shares/${(revoked.data as { id: string }).id}`)).status, 200);
  assert.equal((await opens(revokedLink)).status, 404, 'a revoked link still opened');
  console.log('  a link stopped working once revoked');

  const shown = await api!.get(`/files/${scope}/content`, { params: { path: 'archive/docs/brief.pdf', inline: '1' } });
  assert.match(String(shown.headers['content-disposition']), /^inline;/, 'the PDF was not shown in the page');
  assert.equal(shown.headers['content-security-policy'], "frame-ancestors 'self'", `the PDF's policy would stop the page showing it, or sandbox it, which its viewer refuses: ${String(shown.headers['content-security-policy'])}`);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>parent.alert(document.cookie)</script></svg>');
  for (const [path, type] of [['drawn.svg', 'image/svg+xml'], ['feed.rss', 'application/rss+xml'], ['page.txt', 'text/html']] as const) {
    await stored(scope, path, svg, type);
    const opened = await api!.get(`/files/${scope}/content`, { params: { path, inline: '1' } });
    assert.match(String(opened.headers['content-disposition']), /^attachment;/, `${path} as ${type} was shown in the page`);
    assert.match(String(opened.headers['content-security-policy']), /sandbox$/, `${path} as ${type} may run script`);
    assert.equal(opened.headers['x-content-type-options'], 'nosniff');
  }
  const svgShare = await api!.post(`/files/${scope}/shares`, { path: 'drawn.svg', days: 1 });
  const svgLink = await opens(`${BASE}/share/${(svgShare.data as { token: string }).token}`);
  assert.match(String(svgLink.headers['content-disposition']), /^attachment;/, 'a shared SVG opened in the page');
  assert.match(String(svgLink.headers['content-security-policy']), /sandbox$/, 'a shared SVG may run script');
  assert.equal((await api!.delete(`/files/shares/${(svgShare.data as { id: string }).id}`)).status, 200);
  for (const path of ['drawn.svg', 'feed.rss', 'page.txt']) assert.equal((await api!.delete(`/files/${scope}/content`, { params: { path } })).status, 200);
  console.log('  the PDF shows in the page, its policy framed only by Koala itself; an SVG, an RSS feed and a file calling itself HTML only download, sandboxed, a share link of one too');
}

async function main(): Promise<void> {
  const db = devKoalaDatabase();
  await db.init();
  const signedIn = await devOwner();
  const owner = signedIn.id;
  api = axios.create({ baseURL: BASE, proxy: false, validateStatus: () => true, headers: { Cookie: signedIn.cookie } });
  const koalaTemporal = await devKoalaTemporal();
  const temporal = koalaTemporal.client;
  closeDb = async () => {
    await koalaTemporal.close();
    await db.close?.();
  };
  const runIds = new Set<string>();
  const began = new Date().toISOString();
  retire = async () => {
    for await (const workflow of temporal.workflow.list({ query: `WorkflowId STARTS_WITH "memory-" AND StartTime >= "${began}"` })) runIds.add(workflow.workflowId);
    await forgetWhatRunsLeft(db, owner, new Set([...runIds, ...[...runIds].map((id) => `memory-run-${id}`)]));
  };

  step('code dropped on a project\'s repository is committed in one commit, its bytes whole');
  const shop = await newProject(`files-live-${STAMP}`);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);
  const dropped = await api.post(`/projects/${shop.id}/files/drop`, dropBody({ dir: 'public' }, [{ path: 'logo.png', bytes: png }, { path: 'notes.md', bytes: Buffer.from('# Notes\n') }]), { headers: { 'Content-Type': DROP_TYPE } });
  assert.equal(dropped.status, 201, JSON.stringify(dropped.data));
  assert.deepEqual((dropped.data as { paths: string[] }).paths, ['public/logo.png', 'public/notes.md']);
  const tree = ((await api.get(`/projects/${shop.id}/files`, { params: { path: 'public' } })).data as { entries: { name: string; size?: number }[] }).entries;
  assert.deepEqual(tree.map((entry) => `${entry.name} ${entry.size}`).sort(), [`logo.png ${png.length}`, 'notes.md 8']);
  console.log(`  committed ${(dropped.data as { commit: string }).commit.slice(0, 8)} with logo.png (${png.length} bytes) and notes.md`);

  step('the project keeps its other files on the instance\'s own store, with nothing to choose or start first');
  await exercise(`projects/${shop.id}`, 'the project\'s files');

  step('a file attached in a chat with no project is kept in the chat\'s own files, and Koala reads it with the files tool');
  const conversationId = ((await api.post('/conversations', { title: `Files live ${STAMP}` })).data as { id: string }).id;
  conversations.push(conversationId);
  const chatScope = `conversations/${conversationId}`;
  const fileId = await stored(chatScope, 'live-brief.md', Buffer.from(`The code word is ${TOKEN}.\n`), 'text/markdown');
  assert.deepEqual((await list(chatScope)).map((entry) => entry.path), ['live-brief.md']);
  const chat = await api.post('/engine/runs', {
    agent: 'koala',
    conversationId,
    ...(process.env.FILES_LIVE_MODEL ? { modelId: process.env.FILES_LIVE_MODEL } : {}),
    message: 'Read the file I attached and tell me the code word in it, exactly as written.',
    attachments: [{ fileId, name: 'live-brief.md', type: 'text/markdown' }],
  });
  assert.equal(chat.status, 201, JSON.stringify(chat.data));
  const runId = (chat.data as { runId: string }).runId;
  runIds.add(runId);
  await temporal.workflow.getHandle(workflowOfRun(runId)).result().catch(() => undefined);
  const saved = (await api.get(`/conversations/${conversationId}`)).data as { messages: { role: string; content: string; attachments?: { fileId?: string; name: string }[]; toolCalls?: { name: string }[] }[] };
  const asked = saved.messages.find((message) => message.role === 'user');
  assert.deepEqual(asked?.attachments?.map((entry) => `${entry.fileId} ${entry.name}`), [`${fileId} live-brief.md`], 'the person\'s message keeps what was attached, by its file');
  const reply = saved.messages.filter((message) => message.role === 'assistant').at(-1);
  assert.ok(reply?.toolCalls?.some((call) => call.name === 'read_stored_file'), `Koala did not read the file: ${JSON.stringify(reply?.toolCalls?.map((call) => call.name))}`);
  assert.ok(reply?.content.includes(TOKEN), `the reply was ${JSON.stringify(reply?.content)}`);
  console.log(`  Koala called read_stored_file and answered with ${TOKEN}`);

  step('deleting the project deletes its files');
  const kept = await stored(`projects/${shop.id}`, 'kept/last.txt', Buffer.from('the last file\n'), 'text/plain');
  const lastShare = await api.post(`/files/projects/${shop.id}/shares`, { path: 'kept/last.txt', days: 1 });
  assert.equal(lastShare.status, 201, JSON.stringify(lastShare.data));
  const lastLink = `${BASE}/share/${(lastShare.data as { token: string }).token}`;
  assert.equal((await opens(lastLink)).status, 200);
  assert.ok((await db.files.storedFilesIn(owner, { kind: 'project', id: shop.id })).some((record) => record.id === kept));
  await deleteProject(shop);
  assert.deepEqual(await db.files.storedFilesIn(owner, { kind: 'project', id: shop.id }), [], 'the deleted project\'s files are still recorded');
  assert.equal(await db.files.storedFileById(kept), undefined, 'a file of the deleted project is still recorded');
  assert.equal((await opens(lastLink)).status, 404, 'a link to a file of the deleted project still opens');
  console.log('  nothing of it is left: no record, and its link opens nothing');

  console.log('\nfiles live — PASS');
}

async function teardown(): Promise<void> {
  for (const project of [...projects]) await api?.delete(`/projects/${project.id}`, { data: { confirm: project.name } }).catch(() => undefined);
  for (const id of conversations) await api?.delete(`/conversations/${id}`).catch(() => undefined);
  await retire?.().catch((err: Error) => console.error(`  what the memory keeper kept could not be retired: ${err.message}`));
  await closeDb?.();
}

main().then(async () => { await teardown(); process.exit(0); }, async (err) => {
  console.error(err);
  await teardown();
  process.exit(1);
});
