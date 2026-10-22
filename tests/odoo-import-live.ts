import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)) });
import axios, { type AxiosInstance } from 'axios';
import { createDatabase } from '../apps/backend/src/platform/lib/db-interface.js';
import { signJWT } from '../apps/backend/src/platform/lib/auth.js';
import { loadKeys } from '../apps/backend/src/platform/lib/keys.js';
import { GiteaService } from '../apps/backend/src/projects/services/GiteaService.js';
import { InfrastructureService } from '../apps/backend/src/infrastructure/services/InfrastructureService.js';
import { ODOO_ADDONS_FILES } from '../apps/backend/src/projects/lib/project-templates.js';
import { renderStarterFiles, versionVars } from '../apps/backend/src/projects/lib/tree-types.js';
import { ODOO_TREE_TYPE, TREE_TYPE_SEEDS } from '../apps/backend/src/projects/lib/tree-type-seeds.js';
import { newReleaseName, releasePlace } from '../apps/backend/src/releases/lib/odoo-release.js';
import { channelIdFor } from '../apps/backend/src/engine/lib/conversations.js';

const run = promisify(execFile);
const BASE = process.env.ODOO_IMPORT_LIVE_URL ?? 'http://localhost:3001/api';
const OWNER = process.env.ODOO_IMPORT_LIVE_OWNER ?? process.env.ODOO_RELEASE_LIVE_OWNER ?? process.env.CHECKS_LIVE_OWNER;
const CLUSTER = 'provisioning-lunorica';
const KUBECONFIG = `/tmp/kubeconfig-${CLUSTER}`;
const KUBECTL = fileURLToPath(new URL('../bin/kubectl', import.meta.url));
const STAMP = Date.now().toString(36);
const APP_PORT = 18569 + Math.floor(Math.random() * 400);
const ATTACHED = 'Delivery notes the client kept as a file.';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const env = { ...process.env, KUBECONFIG };

const ODOO_TYPE = TREE_TYPE_SEEDS.find((type) => type.id === ODOO_TREE_TYPE)!;
const ODOO_VERSION = versionVars(ODOO_TYPE, { version: ODOO_TYPE.versions?.default });
const MODULE = 'koala_probe';
const files = (entries: Record<string, string>) => Object.entries(entries).map(([file, content]) => ({ path: file, content }));
const PROBE = files({
  [`addons/${MODULE}/__init__.py`]: 'from . import models\n',
  [`addons/${MODULE}/__manifest__.py`]: `{\n    'name': 'Koala probe',\n    'version': '${ODOO_VERSION.version}.0.1.0.0',\n    'depends': ['base'],\n    'data': ['security/ir.access.csv', 'views/probe.xml'],\n    'license': 'LGPL-3',\n}\n`,
  [`addons/${MODULE}/models/__init__.py`]: 'from . import probe\n',
  [`addons/${MODULE}/models/probe.py`]: "from odoo import fields, models\n\n\nclass Probe(models.Model):\n    _name = 'koala.probe'\n    _description = 'Koala probe'\n\n    name = fields.Char(required=True)\n    note = fields.Char()\n",
  [`addons/${MODULE}/security/ir.access.csv`]: 'id,name,model_id,group_id/id,operation,domain\naccess_koala_probe,koala.probe,koala.probe,base.group_user,crud,\n',
  [`addons/${MODULE}/views/probe.xml`]: '<odoo>\n  <record id="probe_form" model="ir.ui.view">\n    <field name="name">koala.probe.form</field>\n    <field name="model">koala.probe</field>\n    <field name="arch" type="xml">\n      <form><sheet><field name="name"/></sheet></form>\n    </field>\n  </record>\n</odoo>\n',
});

interface Release { id: string; state: string; slot?: string; reason?: string }
interface Made { id: string; name: string; giteaOwner: string; giteaRepo: string; place: ReturnType<typeof releasePlace> }

const REWRITE = `
import json, sys, zipfile
source, target, change = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
with zipfile.ZipFile(source) as old, zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as new:
    for item in old.infolist():
        data = old.read(item.filename)
        if item.filename == 'manifest.json':
            manifest = json.loads(data)
            manifest.update({key: value for key, value in change.items() if key != 'modules'})
            manifest['modules'].update(change.get('modules', {}))
            data = json.dumps(manifest).encode()
        new.writestr(item, data)
`;

async function main(): Promise<void> {
  assert.ok(OWNER, 'set ODOO_IMPORT_LIVE_OWNER (or ODOO_RELEASE_LIVE_OWNER) to the person the projects are made for');
  const db = createDatabase();
  await db.init();
  const user = await db.getUserById(OWNER);
  assert.ok(user, 'no such user');
  const http: AxiosInstance = axios.create({ baseURL: BASE, proxy: false, timeout: 0, maxBodyLength: Infinity, validateStatus: () => true, headers: { Cookie: `session=${signJWT({ userId: user.id, email: user.email }, loadKeys(process.env).session, 4 * 3600)}` } });
  const gitea = new GiteaService(new InfrastructureService(), loadKeys(process.env).data, KUBECONFIG);
  const kubectl = async (namespace: string, ...args: string[]) => (await run(KUBECTL, ['-n', namespace, ...args], { env, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
  const psql = (made: Made, sql: string) => kubectl(made.place.namespace, 'exec', `${made.place.release}-postgres-0`, '--', 'psql', '-U', 'odoo', '-d', 'odoo_a', '-tAc', sql);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'odoo-import-live-'));
  const made: Made[] = [];

  const project = async (role: string): Promise<Made> => {
    const name = `odoo-import-${role}-${STAMP}`;
    const answer = await http.post('/projects', { name, giteaRepo: name, createRepo: true });
    assert.ok(answer.status < 300, JSON.stringify(answer.data));
    const entry = { ...(answer.data as Omit<Made, 'place'>), place: releasePlace(newReleaseName(answer.data)) };
    made.push(entry);
    return entry;
  };
  const seed = (entry: Made) => gitea.getRegistryHost().then((registryHost) => gitea.seedTemplate(entry.giteaOwner, entry.giteaRepo, [...renderStarterFiles(ODOO_ADDONS_FILES, { projectName: entry.name, registryHost, ...ODOO_VERSION }), ...PROBE]));
  const releases = async (entry: Made): Promise<Release[]> => (await http.get(`/projects/${entry.id}/releases`)).data.releases;
  const waitFor = async <T>(what: string, check: () => Promise<T | undefined>, minutes: number): Promise<T> => {
    const until = Date.now() + minutes * 60_000;
    while (Date.now() < until) {
      const found = await check();
      if (found !== undefined) return found;
      await sleep(10_000);
    }
    throw new Error(`no ${what} within ${minutes} minutes`);
  };
  const live = async (entry: Made) => {
    const before = new Set((await releases(entry)).map((release) => release.id));
    return liveAfter(entry, before);
  };
  const liveAfter = (entry: Made, before: ReadonlySet<string>) => waitFor(`live release of ${entry.name}`, async () => {
    const all = (await releases(entry)).filter((release) => !before.has(release.id));
    const failed = all.find((release) => release.state === 'failed');
    if (failed) throw new Error(`${entry.name}'s release failed: ${failed.reason}`);
    return all.find((release) => release.state === 'live');
  }, 30);
  const importOf = async (entry: Made) => (await http.get(`/projects/${entry.id}/import`)).data as { open: boolean; why?: string; import?: { state: string; mode: string; version?: string; modules?: string[]; missing?: string[]; reason?: string } };
  const upload = async (entry: Made, file: string, mode: 'copy' | 'live') => http.put(`/projects/${entry.id}/import`, createReadStream(file), {
    params: { mode },
    headers: { 'Content-Type': 'application/zip', 'Content-Length': String((await fs.stat(file)).size) },
  });
  const rewrite = async (from: string, to: string, change: Record<string, unknown>) => { await run('python3', ['-I', '-c', REWRITE, from, to, JSON.stringify(change)]); return to; };

  try {
    console.log('[1] the client\'s Odoo: a project released into slot a, where they made a field, edited a view, kept probes with notes, a file, and a mail server');
    const client = await project('client');
    await seed(client);
    await live(client);
    const signIn = ((await http.get(`/projects/${client.id}/sign-in`)).data as { signIns: { login: string; password: string }[] }).signIns[0]!;
    const forward = spawn(KUBECTL, ['-n', client.place.namespace, 'port-forward', `svc/${client.place.release}-live`, `${APP_PORT}:8069`], { env, stdio: 'ignore' });
    try {
      for (let tries = 0; tries < 30 && !(await axios.get(`http://127.0.0.1:${APP_PORT}/web/health`, { proxy: false, timeout: 2_000, validateStatus: () => true }).then((answer) => answer.status === 200, () => false)); tries += 1) await sleep(1_000);
      const rpc = async (service: string, method: string, args: unknown[]): Promise<unknown> => {
        const answer = (await axios.post(`http://127.0.0.1:${APP_PORT}/jsonrpc`, { jsonrpc: '2.0', method: 'call', params: { service, method, args } }, { proxy: false, timeout: 60_000 })).data as { result?: unknown; error?: { data?: { message?: string } } };
        if (answer.error) throw new Error(`Odoo refused ${method}: ${answer.error.data?.message ?? JSON.stringify(answer.error)}`);
        return answer.result;
      };
      const uid = await rpc('common', 'login', ['odoo_a', signIn.login, signIn.password]);
      const call = (model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}) => rpc('object', 'execute_kw', ['odoo_a', uid, signIn.password, model, method, args, kwargs]);
      const [probeModel] = await call('ir.model', 'search', [[['model', '=', 'koala.probe']]]) as number[];
      await call('ir.model.fields', 'create', [{ name: 'x_koala_note', field_description: 'Koala note', model_id: probeModel, ttype: 'char', state: 'manual' }]);
      const [form] = await call('ir.model.data', 'search_read', [[['module', '=', MODULE], ['name', '=', 'probe_form']]], { fields: ['res_id'] }) as { res_id: number }[];
      await call('ir.ui.view', 'write', [[form!.res_id], { arch: '<form><sheet><field name="name"/><field name="x_koala_note"/></sheet></form>' }]);
      await call('koala.probe', 'create', [[{ name: 'first', note: 'leave at the back door' }, { name: 'second', note: 'ring twice' }]]);
      await call('ir.attachment', 'create', [{ name: 'notes.txt', raw: Buffer.from(ATTACHED).toString('base64') }]);
      const [stored] = await call('ir.attachment', 'search_read', [[['name', '=', 'notes.txt']]], { fields: ['store_fname', 'file_size'] }) as { store_fname: string | false; file_size: number }[];
      assert.ok(stored?.store_fname, `the client's file was not stored: ${JSON.stringify(stored)}`);
      await call('ir.mail_server', 'create', [{ name: 'Client SMTP', smtp_host: 'smtp.client.invalid', smtp_port: 587 }]);
    } finally {
      forward.kill();
    }
    const clientUuid = await psql(client, "select value from ir_config_parameter where key = 'database.uuid'");
    console.log('    made through Odoo\'s own API');

    console.log('[2] the client backs it up the way Odoo\'s database manager does (odoo db dump, a zip with its files)');
    const pod = `deploy/${client.place.release}-odoo-a`;
    await kubectl(client.place.namespace, 'exec', pod, '--', 'sh', '-c', 'odoo db --db_host "$HOST" --db_user "$USER" --db_password "$PASSWORD" --data-dir /var/lib/odoo dump odoo_a /tmp/client.zip');
    const backup = path.join(dir, 'client.zip');
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(backup);
      const copy = spawn(KUBECTL, ['-n', client.place.namespace, 'exec', pod, '--', 'cat', '/tmp/client.zip'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
      copy.stdout.pipe(out);
      copy.on('error', reject);
      copy.on('close', (code) => (code === 0 ? out.close(() => resolve()) : reject(new Error(`copying the backup out failed (${code})`))));
    });
    const bytes = (await fs.stat(backup)).size;
    console.log(`    ${bytes} bytes`);

    console.log('[3] a new project refuses a backup from another Odoo version at once, and keeps nothing of it');
    const copy = await project('copy');
    const older = await rewrite(backup, path.join(dir, 'older.zip'), { major_version: '17.0', version: '17.0' });
    const refusedVersion = await upload(copy, older, 'copy');
    assert.equal(refusedVersion.status, 409, JSON.stringify(refusedVersion.data));
    assert.equal(refusedVersion.data.error, `the backup is from Odoo 17.0, and this project runs Odoo ${ODOO_VERSION.version}.0; moving a database from one Odoo version to another is a step of its own`);
    assert.equal((await importOf(copy)).import?.state, 'refused');
    console.log(`    ${refusedVersion.data.error}`);

    console.log('[4] a backup naming a module this project does not have is taken in, and its restore refuses it, naming the module');
    const studio = await rewrite(backup, path.join(dir, 'studio.zip'), { modules: { web_studio: '20.0.1.0' } });
    const uploaded = await upload(copy, studio, 'copy');
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data));
    assert.equal(uploaded.data.state, 'uploaded');
    await seed(copy);
    const refused = await waitFor('the restore to refuse it', async () => {
      const entry = (await importOf(copy)).import;
      return entry?.state === 'refused' && entry.missing ? entry : undefined;
    }, 30);
    assert.deepEqual(refused.missing, ['web_studio']);
    assert.equal((await releases(copy)).some((release) => release.state === 'live'), false, 'something went live from a refused backup');
    console.log(`    ${refused.reason}`);

    console.log('[5] the real backup, as a copy: restored into slot a with its records and files, neutralized, and its customizations listed');
    const refusedReleases = new Set((await releases(copy)).map((release) => release.id));
    const accepted = await upload(copy, backup, 'copy');
    assert.equal(accepted.status, 201, JSON.stringify(accepted.data));
    assert.equal(accepted.data.version, `${ODOO_VERSION.version}.0`);
    assert.ok((accepted.data.modules as string[]).includes(MODULE));
    const restored = await liveAfter(copy, refusedReleases);
    assert.equal(restored.slot, 'a');
    await waitFor('the import to be recorded as done', async () => ((await importOf(copy)).import?.state === 'imported' ? true : undefined), 2);
    assert.equal(await psql(copy, "select string_agg(name || ':' || note, ',' order by name) from koala_probe"), 'first:leave at the back door,second:ring twice');
    const stored = await psql(copy, "select store_fname from ir_attachment where name = 'notes.txt'");
    assert.equal(await kubectl(copy.place.namespace, 'exec', `deploy/${copy.place.release}-odoo-a`, '--', 'cat', `/var/lib/odoo/filestore/odoo_a/${stored}`), ATTACHED, 'the client\'s file did not come with the database');
    assert.equal(await psql(copy, "select value from ir_config_parameter where key = 'database.is_neutralized'"), 'True');
    assert.equal(await psql(copy, "select active from ir_mail_server where name = 'Client SMTP'"), 'f', 'the client\'s mail server still sends');
    assert.notEqual(await psql(copy, "select value from ir_config_parameter where key = 'database.uuid'"), clientUuid, 'the copy kept the client\'s database identity');
    const drift = (await http.get(`/projects/${copy.id}/customizations`)).data as { items: { kind: string }[] };
    assert.deepEqual(drift.items.map((item) => item.kind).sort(), ['edited-view', 'field']);
    const copySignIn = ((await http.get(`/projects/${copy.id}/sign-in`)).data as { signIns: { login: string; password: string }[] }).signIns[0]!;
    assert.notEqual(copySignIn.password, signIn.password, 'the copy\'s sign-in is the client\'s');
    const channel = await db.getConversation(OWNER, channelIdFor(copy.id));
    const notice = channel?.messages.find((message) => message.role === 'notice' && message.content.startsWith('The client\'s database'));
    assert.ok(notice, `no notice that the client's database is live: ${JSON.stringify(channel?.messages.map((message) => message.content))}`);
    assert.match(notice.content, /2 things were made in their app/);
    assert.equal(await kubectl(copy.place.namespace, 'get', 'pvc', `${copy.place.release}-import`, '--ignore-not-found', '-o', 'name'), '', 'the upload was left behind');
    assert.equal((await importOf(copy)).open, false, 'a project that has released still offers to start from a client\'s database');
    console.log(`    ${notice.content}`);

    console.log('[6] the same backup as the client\'s live system keeps its mail server and identity');
    const kept = await project('live');
    const keptUpload = await upload(kept, backup, 'live');
    assert.equal(keptUpload.status, 201, JSON.stringify(keptUpload.data));
    await seed(kept);
    await live(kept);
    assert.equal(await psql(kept, "select count(*) from ir_config_parameter where key = 'database.is_neutralized'"), '0');
    assert.equal(await psql(kept, "select active from ir_mail_server where name = 'Client SMTP'"), 't');
    assert.equal(await psql(kept, "select value from ir_config_parameter where key = 'database.uuid'"), clientUuid);
    console.log('    live as it was: the mail server is on, and the database is the client\'s');

    console.log('[7] deleting the projects takes their apps and namespaces with them');
    for (const entry of made.splice(0)) {
      const removing = await http.delete(`/projects/${entry.id}`, { data: { confirm: entry.name } });
      assert.ok(removing.status < 300, JSON.stringify(removing.data));
      await waitFor(`${entry.place.namespace} to go`, async () => ((await run(KUBECTL, ['get', 'namespace', entry.place.namespace, '--ignore-not-found', '-o', 'name'], { env })).stdout.trim() === '' ? true : undefined), 10);
    }
    console.log('odoo import live — PASS');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    if (made.length && process.env.ODOO_IMPORT_LIVE_KEEP === '1') {
      console.log(`[8] the run stopped early, and ODOO_IMPORT_LIVE_KEEP keeps what it made: ${made.map((entry) => `${entry.name} (${entry.id})`).join(', ')}`);
    } else {
      for (const entry of made) await http.delete(`/projects/${entry.id}`, { data: { confirm: entry.name } }).catch(() => undefined);
    }
  }
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
