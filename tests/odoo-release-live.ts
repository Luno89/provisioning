import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)) });
import axios from 'axios';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import { signJWT } from '../apps/backend/src/lib/auth.js';
import { loadKeys } from '../apps/backend/src/lib/keys.js';
import { GiteaService } from '../apps/backend/src/services/GiteaService.js';
import { InfrastructureService } from '../apps/backend/src/services/InfrastructureService.js';
import { ODOO_ADDONS_FILES } from '../apps/backend/src/lib/project-templates.js';
import { renderStarterFiles, versionVars } from '../apps/backend/src/lib/tree-types.js';
import { ODOO_TREE_TYPE, TREE_TYPE_SEEDS } from '../apps/backend/src/lib/tree-type-seeds.js';
import { newReleaseName, releasePlace } from '../apps/backend/src/lib/odoo-release.js';
import { releaseRunWorkflowId } from '../apps/backend/src/lib/release-run.js';
import { getTemporalClient } from '../apps/backend/src/lib/temporal-client.js';
import { labelValue } from '../apps/backend/src/engine-host/sandboxes/workspace.js';

const run = promisify(execFile);
const BASE = process.env.ODOO_RELEASE_LIVE_URL ?? 'http://localhost:3001/api';
const OWNER = process.env.ODOO_RELEASE_LIVE_OWNER ?? process.env.CHECKS_LIVE_OWNER ?? process.env.GROVE_LIVE_OWNER;
const CLUSTER = 'provisioning-lunorica';
const KUBECONFIG = `/tmp/kubeconfig-${CLUSTER}`;
const KUBECTL = fileURLToPath(new URL('../bin/kubectl', import.meta.url));
const NAME = `odoo-release-check-${Date.now().toString(36)}`;
const APP_PORT = 18069 + Math.floor(Math.random() * 500);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ODOO_TYPE = TREE_TYPE_SEEDS.find((type) => type.id === ODOO_TREE_TYPE)!;
const ODOO_VERSION = versionVars(ODOO_TYPE, { version: ODOO_TYPE.versions?.default });
const MODULE = 'koala_probe';
const EXTRA = 'koala_probe_extra';
const files = (entries: Record<string, string>) => Object.entries(entries).map(([path, content]) => ({ path, content }));

const probeFiles = (withNote: boolean) => files({
  [`addons/${MODULE}/__init__.py`]: 'from . import models\n',
  [`addons/${MODULE}/__manifest__.py`]: `{\n    'name': 'Koala probe',\n    'version': '${ODOO_VERSION.version}.0.1.0.0',\n    'depends': ['base'],\n    'data': ['security/ir.access.csv', 'views/probe.xml'],\n    'license': 'LGPL-3',\n}\n`,
  [`addons/${MODULE}/models/__init__.py`]: 'from . import probe\n',
  [`addons/${MODULE}/models/probe.py`]: `from odoo import fields, models\n\n\nclass Probe(models.Model):\n    _name = 'koala.probe'\n    _description = 'Koala probe'\n\n    name = fields.Char(required=True)\n${withNote ? '    note = fields.Char()\n' : ''}`,
  [`addons/${MODULE}/security/ir.access.csv`]: 'id,name,model_id,group_id/id,operation,domain\naccess_koala_probe,koala.probe,koala.probe,base.group_user,crud,\n',
  [`addons/${MODULE}/views/probe.xml`]: '<odoo>\n  <record id="probe_form" model="ir.ui.view">\n    <field name="name">koala.probe.form</field>\n    <field name="model">koala.probe</field>\n    <field name="arch" type="xml">\n      <form><sheet><field name="name"/></sheet></form>\n    </field>\n  </record>\n</odoo>\n',
});

const PROBE = probeFiles(true);
const PROBE_WITHOUT_NOTE = probeFiles(false);

const COLOUR = files({
  [`addons/${EXTRA}/__init__.py`]: 'from . import models\n',
  [`addons/${EXTRA}/__manifest__.py`]: `{\n    'name': 'Koala probe colour',\n    'version': '${ODOO_VERSION.version}.0.1.0.0',\n    'depends': ['${MODULE}'],\n    'license': 'LGPL-3',\n}\n`,
  [`addons/${EXTRA}/models/__init__.py`]: 'from . import probe\n',
  [`addons/${EXTRA}/models/probe.py`]: "from odoo import fields, models\n\n\nclass Probe(models.Model):\n    _inherit = 'koala.probe'\n\n    colour = fields.Char()\n",
});

const SAVES = files({
  'e2e/saves-a-contact.spec.ts': [
    "import { test, expect, signIn, openAction, fill, save } from './odoo';",
    '',
    "test('a person saves a new contact', async ({ page }) => {",
    '  await signIn(page);',
    "  await openAction(page, 'base.action_partner_form', { newRecord: true });",
    "  await fill(page, 'name', 'Saved in the preview');",
    '  expect(await save(page)).toBeGreaterThan(0);',
    '});',
    '',
  ].join('\n'),
});

const FAILING = files({
  'e2e/never-made.spec.ts': [
    "import { test, expect } from '@playwright/test';",
    '',
    "test('a person sees the never-made field on the home page', async ({ page }) => {",
    "  await page.goto('/web/login');",
    "  await page.fill('input[name=\"login\"]', process.env.ODOO_LOGIN!);",
    "  await page.fill('input[name=\"password\"]', process.env.ODOO_PASSWORD!);",
    "  await page.click('button[type=\"submit\"]');",
    "  await expect(page.locator('.o_main_navbar')).toBeVisible();",
    "  await expect(page.locator('[name=\"koala_never_made\"]')).toBeVisible({ timeout: 3_000 });",
    '});',
    '',
  ].join('\n'),
});

interface BrowserTests { state: string; summary?: string; reason?: string; tests?: { title: string; status: string; error?: string }[]; artifacts?: { id: string; name: string }[] }
interface ReleaseFiles { against?: { releaseId: string; commit: string; state: string }; files: { path: string; status: string; added: number; removed: number; patch: string; inApp: boolean }[]; note?: string }
interface Changes { losing: boolean; lost: string[]; columns: { table: string; column: string; filled: number }[]; items: { kind: string; name: string; state: string }[] }
interface Release { id: string; state: string; commit: string; image: string; again?: string; slot?: string; reason?: string; previewHost?: string; e2e?: BrowserTests; changes?: Changes }

async function main(): Promise<void> {
  assert.ok(OWNER, 'set ODOO_RELEASE_LIVE_OWNER (or CHECKS_LIVE_OWNER) to the person the project is made for');
  const db = createDatabase();
  await db.init();
  const user = await db.getUserById(OWNER);
  assert.ok(user, 'no such user');
  const http = axios.create({ baseURL: BASE, proxy: false, timeout: 60_000, validateStatus: () => true, headers: { Cookie: `session=${signJWT({ userId: user.id, email: user.email }, loadKeys(process.env).session, 4 * 3600)}` } });
  const gitea = new GiteaService(new InfrastructureService(), loadKeys(process.env).data, KUBECONFIG);
  let place = releasePlace(NAME);
  const kubectl = async (...args: string[]) => (await run(KUBECTL, ['-n', place.namespace, ...args], { env: { ...process.env, KUBECONFIG } })).stdout.trim();
  const psql = (database: string, sql: string) => kubectl('exec', `${place.release}-postgres-0`, '--', 'psql', '-U', 'odoo', '-d', database, '-tAc', sql);
  const columns = (database: string) => psql(database, "select column_name from information_schema.columns where table_name = 'koala_probe' order by 1");
  const health = async (service: string): Promise<string> => {
    const answer = await run(KUBECTL, ['get', '--raw', `/api/v1/namespaces/${place.namespace}/services/http:${service}:8069/proxy/web/health`], { env: { ...process.env, KUBECONFIG } })
      .then((out) => out.stdout, (err: Error) => err.message);
    return /"status"\s*:\s*"pass"/.test(answer) ? '200' : answer.trim().slice(0, 200);
  };

  let projectId: string | undefined;
  const releaseIds: string[] = [];
  try {
    console.log(`[1] a project with no cluster picked, so on its own (the system cluster): ${NAME}`);
    const made = await http.post('/projects', { name: NAME, giteaRepo: NAME, createRepo: true });
    assert.ok(made.status < 300, JSON.stringify(made.data));
    assert.equal(made.data.targetClusterId, CLUSTER, 'a project with no cluster picked deploys to its own');
    const project = made.data as { id: string; name: string; giteaOwner: string; giteaRepo: string };
    projectId = project.id;
    place = releasePlace(newReleaseName(project));

    const releases = async (): Promise<Release[]> => (await http.get(`/projects/${projectId}/releases`)).data.releases;
    const waitFor = async (what: string, ok: (all: Release[]) => Release | undefined, minutes: number): Promise<Release> => {
      const until = Date.now() + minutes * 60_000;
      let last = '';
      while (Date.now() < until) {
        const all = await releases();
        const now = all.map((release) => `${release.state}${release.slot ? `/${release.slot}` : ''}`).join(', ');
        if (now !== last) { console.log(`    ${new Date().toISOString().slice(11, 19)} ${now || 'no release yet'}`); last = now; }
        const failed = all.find((release) => release.state === 'failed');
        if (failed) throw new Error(`a release failed: ${failed.reason}`);
        const found = ok(all);
        if (found) return found;
        await sleep(10_000);
      }
      throw new Error(`no ${what} within ${minutes} minutes`);
    };

    console.log('[2] the Odoo starter and a module land on main in one commit: it builds and releases into slot a');
    await gitea.seedTemplate(project.giteaOwner, project.giteaRepo, [...renderStarterFiles(ODOO_ADDONS_FILES, { projectName: NAME, registryHost: await gitea.getRegistryHost(), ...ODOO_VERSION }), ...PROBE]);
    const first = await waitFor('first release', (all) => all.find((release) => release.state === 'live'), 30);
    assert.equal(first.slot, 'a');
    assert.equal((await db.getProjects()).find((entry) => entry.id === projectId)?.releaseName, place.release, 'the project does not keep the name its release was given');
    const labels = JSON.parse(await run(KUBECTL, ['get', 'namespace', place.namespace, '-o', 'jsonpath={.metadata.labels}'], { env: { ...process.env, KUBECONFIG } }).then((out) => out.stdout)) as Record<string, string>;
    assert.equal(labels['koala.dev/project'], labelValue(projectId), `the release namespace does not say whose project it is: ${JSON.stringify(labels)}`);
    assert.ok(labels['koala.dev/owner'], 'the release namespace does not say whose it is');
    console.log(`    released as ${place.release}, a name of its own, in a namespace labelled with its owner and project`);
    assert.equal(await health(`${place.release}-live`), '200', 'the live slot does not answer');
    assert.match(await psql('odoo_a', `select state from ir_module_module where name = '${MODULE}'`), /installed/);
    assert.doesNotMatch(await columns('odoo_a'), /colour/);
    console.log('    live on slot a: Odoo answers, koala_probe is installed');

    console.log('[2a] someone works in the live app: a field made in the app, the probe form edited in the app, and probes with notes');
    const signIn = ((await http.get(`/projects/${projectId}/sign-in`)).data as { signIns: { login: string; password: string }[] }).signIns[0];
    assert.ok(signIn, 'the project has no sign-in for its app');
    const forward = spawn(KUBECTL, ['-n', place.namespace, 'port-forward', `svc/${place.release}-live`, `${APP_PORT}:8069`], { env: { ...process.env, KUBECONFIG }, stdio: 'ignore' });
    try {
      for (let tries = 0; tries < 30 && !(await axios.get(`http://127.0.0.1:${APP_PORT}/web/health`, { proxy: false, timeout: 2_000, validateStatus: () => true }).then((answer) => answer.status === 200, () => false)); tries += 1) await sleep(1_000);
      const rpc = async (service: string, method: string, args: unknown[]): Promise<unknown> => {
        const answer = (await axios.post(`http://127.0.0.1:${APP_PORT}/jsonrpc`, { jsonrpc: '2.0', method: 'call', params: { service, method, args } }, { proxy: false, timeout: 60_000 })).data as { result?: unknown; error?: { data?: { message?: string } } };
        if (answer.error) throw new Error(`Odoo refused ${method}: ${answer.error.data?.message ?? JSON.stringify(answer.error)}`);
        return answer.result;
      };
      const uid = await rpc('common', 'login', ['odoo_a', signIn.login, signIn.password]);
      assert.ok(uid, 'the app\'s sign-in does not sign in');
      const call = (model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}) => rpc('object', 'execute_kw', ['odoo_a', uid, signIn.password, model, method, args, kwargs]);
      const [probeModel] = await call('ir.model', 'search', [[['model', '=', 'koala.probe']]]) as number[];
      await call('ir.model.fields', 'create', [{ name: 'x_koala_note', field_description: 'Koala note', model_id: probeModel, ttype: 'char', state: 'manual' }]);
      const [form] = await call('ir.model.data', 'search_read', [[['module', '=', MODULE], ['name', '=', 'probe_form']]], { fields: ['res_id'] }) as { res_id: number }[];
      await call('ir.ui.view', 'write', [[form!.res_id], { arch: '<form><sheet><field name="name"/><field name="x_koala_note"/></sheet></form>' }]);
      await call('koala.probe', 'create', [[{ name: 'first', note: 'leave at the back door' }, { name: 'second', note: 'ring twice' }, { name: 'third' }]]);
    } finally {
      forward.kill();
    }
    assert.equal(await psql('odoo_a', "select count(*) from koala_probe where note is not null"), '2');
    assert.equal(await psql('odoo_a', "select arch_updated from ir_ui_view where id = (select res_id from ir_model_data where module = 'koala_probe' and name = 'probe_form')"), 't', 'the edit did not mark the view edited in the app');
    console.log('    made through Odoo\'s own API, signed in with the project\'s sign-in');

    console.log('[3] a new module adds a field and the probe loses its note: the next build is prepared in slot b, compared with live, and waits in preview');
    await gitea.commitFiles(project.giteaOwner, project.giteaRepo, [...COLOUR, ...PROBE_WITHOUT_NOTE, ...SAVES], 'Add the colour module and a browser test that saves a contact, and the probe no longer keeps a note');
    const preview = await waitFor('preview', (all) => all.find((release) => release.state === 'preview'), 30);
    assert.equal(preview.slot, 'b');
    assert.match(await columns('odoo_b'), /colour/, 'slot b\'s copy has no colour column');
    assert.doesNotMatch(await columns('odoo_a'), /colour/, 'the live database changed before the cutover');
    assert.equal(await kubectl('get', 'svc', `${place.release}-live`, '-o', 'jsonpath={.spec.selector.koala\\.dev/slot}'), 'a');
    assert.equal(await health(`${place.release}-odoo-b`), '200', 'the preview slot does not answer');
    assert.match(await kubectl('get', 'ingress', 'app', '-o', 'jsonpath={.spec.rules[*].host}'), new RegExp(place.previewHost.replace(/\./g, '\\.')));
    console.log('    preview on slot b: it has the colour field, the live slot does not');

    console.log('[3e] the preview says what cutting over would lose, and keeps what was made in the app');
    const compared = (await releases()).find((release) => release.id === preview.id)!;
    assert.ok(compared.changes, 'the preview was not compared with live');
    console.log(`    ${JSON.stringify({ lost: compared.changes.lost, items: compared.changes.items.map((item) => `${item.kind}: ${item.state}`) })}`);
    assert.equal(compared.changes.losing, true);
    assert.deepEqual(compared.changes.columns.find((entry) => entry.column === 'note'), { table: 'koala_probe', column: 'note', filled: 2 });
    assert.ok(compared.changes.lost.includes('the column koala_probe.note is dropped; 2 rows held a value in it'), JSON.stringify(compared.changes.lost));
    assert.deepEqual(compared.changes.items.filter((item) => item.kind === 'edited-view').map((item) => item.state), ['reset']);
    assert.deepEqual(compared.changes.items.filter((item) => item.kind === 'field').map((item) => [item.name, item.state]), [['The field Koala note (x_koala_note) on koala.probe, made in the app,', 'kept']]);
    assert.equal(compared.changes.items.filter((item) => item.state !== 'kept' && item.kind !== 'edited-view').length, 0, `something else was flagged: ${JSON.stringify(compared.changes.items)}`);
    assert.match(await columns('odoo_a'), /\bnote\b/, 'the live slot lost its note column before any cut-over');
    assert.doesNotMatch(await columns('odoo_b'), /\bnote\b/, 'the preview still has the note column the release drops');

    console.log('[3a] the preview is quiet, and passes the project\'s browser tests signed in as its own test user');
    assert.equal(await psql('odoo_b', 'select count(*) from ir_cron where active'), '0', 'the preview still runs scheduled jobs');
    assert.equal(await psql('odoo_b', 'select count(*) from ir_mail_server where active'), '0', 'the preview can still send mail');
    assert.notEqual(await psql('odoo_a', 'select count(*) from ir_cron where active'), '0', 'the live database lost its scheduled jobs');
    const tested = await waitFor('browser tests on the preview', (all) => all.find((release) => release.id === preview.id && release.e2e && release.e2e.state !== 'running'), 15);
    assert.equal(tested.e2e!.state, 'passed', JSON.stringify(tested.e2e));
    assert.equal(tested.e2e!.summary, '2 passed, 0 failed');
    assert.deepEqual(tested.e2e!.tests!.map((test) => [test.title, test.status]).sort(), [['a person saves a new contact', 'passed'], ['a person signs in and reaches the Odoo home', 'passed']]);
    assert.equal(await psql('odoo_b', "select count(*) from res_users where login = 'koala-e2e' and active"), '1', 'the preview has no test user');
    const avatars = (await psql('odoo_b', "select a.store_fname from ir_attachment a join res_users u on a.res_model = 'res.partner' and a.res_id = u.partner_id where u.login = 'koala-e2e' and a.store_fname is not null")).split('\n').filter(Boolean);
    assert.ok(avatars.length > 0, 'the test user has no avatar to look for');
    const slotB = (await kubectl('get', 'pods', '-o', 'name')).split('\n').find((line) => line.includes(`${place.release}-odoo-b`))!;
    for (const file of avatars) await kubectl('exec', slotB.replace('pod/', ''), '--', 'test', '-f', `/var/lib/odoo/filestore/odoo_b/${file}`).catch(() => assert.fail(`the test user's ${file} is in the database but not in the preview's filestore`));
    assert.equal(await psql('odoo_a', "select count(*) from res_users where login = 'koala-e2e'"), '0', 'the test user reached the live database');
    assert.equal(await kubectl('get', 'jobs', '-l', 'app.kubernetes.io/component=e2e', '-o', 'name').then((out) => out.split('\n').filter((line) => line.includes('/' + place.release + '-e2e')).filter((line) => !line.includes('login')).length), 0, 'the browser job was left behind');
    console.log(`    ${tested.e2e!.summary}: signed in as koala-e2e, a contact saved, the test user's ${avatars.length} avatar files in the preview's filestore; slot a has no such user`);

    console.log('[3g] the preview lists the files it changes since what is live, each with its diff');
    const changedFiles = (await http.get(`/projects/${projectId}/releases/${preview.id}/files`)).data as ReleaseFiles;
    assert.deepEqual(changedFiles.against, { releaseId: first.id, commit: first.commit, state: 'live' }, JSON.stringify(changedFiles));
    assert.deepEqual(changedFiles.files.map((file) => [file.path, file.status]), [
      [`addons/${EXTRA}/__init__.py`, 'added'], [`addons/${EXTRA}/__manifest__.py`, 'added'], [`addons/${EXTRA}/models/__init__.py`, 'added'], [`addons/${EXTRA}/models/probe.py`, 'added'],
      [`addons/${MODULE}/models/probe.py`, 'modified'], ['e2e/saves-a-contact.spec.ts', 'added'],
    ], JSON.stringify(changedFiles.files.map((file) => file.path)));
    const probeChange = changedFiles.files.find((file) => file.path === `addons/${MODULE}/models/probe.py`)!;
    assert.deepEqual([probeChange.added, probeChange.removed], [0, 1]);
    assert.match(probeChange.patch, /^-\s+note = fields\.Char\(\)$/m);
    console.log(`    ${changedFiles.files.length} files since ${first.commit.slice(0, 8)}: the probe's diff drops its note line`);

    console.log('[3c] a spec that cannot pass: the next preview shows the failure and what the browser saw, and still offers the cutover');
    await gitea.seedTemplate(project.giteaOwner, project.giteaRepo, FAILING);
    const failing = await waitFor('the failing preview\'s browser tests', (all) => all.find((release) => release.id !== preview.id && release.state === 'preview' && release.e2e && release.e2e.state !== 'running'), 30);
    assert.equal((await releases()).find((release) => release.id === preview.id)?.state, 'superseded');
    assert.equal(failing.e2e!.state, 'failed', JSON.stringify(failing.e2e));
    assert.equal(failing.e2e!.summary, '2 passed, 1 failed');
    const failed = failing.e2e!.tests!.find((test) => test.status === 'failed');
    assert.equal(failed?.title, 'a person sees the never-made field on the home page');
    assert.match(failed?.error ?? '', /toBeVisible/);
    const shot = failing.e2e!.artifacts?.find((artifact) => artifact.name.endsWith('.png'));
    assert.ok(shot, `no screenshot kept: ${JSON.stringify(failing.e2e!.artifacts)}`);
    const image = await http.get(`/artifacts/${shot.id}`, { responseType: 'arraybuffer' });
    assert.equal(image.status, 200);
    assert.equal(Buffer.from(image.data).subarray(1, 4).toString(), 'PNG', 'the screenshot is not a PNG');
    assert.ok(failing.e2e!.artifacts!.some((artifact) => artifact.name.endsWith('trace.zip')), 'no trace kept');
    console.log(`    ${failing.e2e!.summary}: "${failed!.title}" failed; ${failing.e2e!.artifacts!.length} files kept, the screenshot opens (${Buffer.from(image.data).length} bytes)`);

    console.log('[3d] running the tests again from the card');
    const again = await http.post(`/projects/${projectId}/releases/${failing.id}/retest`, {});
    assert.equal(again.status, 202, JSON.stringify(again.data));
    await waitFor('the second run to start', (all) => all.find((release) => release.id === failing.id && release.e2e?.state === 'running'), 2);
    const rerun = await waitFor('the second run to finish', (all) => all.find((release) => release.id === failing.id && release.e2e && release.e2e.state !== 'running'), 15);
    assert.equal(rerun.e2e!.state, 'failed');
    console.log(`    ran again: ${rerun.e2e!.summary}`);

    console.log('[3f] the first preview\'s build released again: the waiting preview is set aside, and the same image is prepared afresh and tested');
    const releasedAgain = await http.post(`/projects/${projectId}/releases/${preview.id}/again`, {});
    assert.equal(releasedAgain.status, 202, JSON.stringify(releasedAgain.data));
    const repeat = (releasedAgain.data as { release: Release }).release;
    assert.deepEqual([repeat.again, repeat.image, repeat.commit], [preview.id, preview.image, preview.commit]);
    const candidate = await waitFor('the build released again to be tested', (all) => all.find((release) => release.id === repeat.id && release.state === 'preview' && release.e2e && release.e2e.state !== 'running'), 30);
    assert.equal((await releases()).find((release) => release.id === failing.id)?.state, 'superseded', 'the waiting preview was not set aside');
    assert.equal(candidate.slot, 'b');
    assert.equal(candidate.e2e!.summary, '2 passed, 0 failed', JSON.stringify(candidate.e2e));
    assert.ok(candidate.changes?.losing, 'the build released again was not compared with live');
    const againFiles = (await http.get(`/projects/${projectId}/releases/${candidate.id}/files`)).data as ReleaseFiles;
    assert.ok(!againFiles.files.some((file) => file.path === 'e2e/never-made.spec.ts'), 'the build released again carries the later commit\'s spec');
    assert.equal(againFiles.files.length, changedFiles.files.length);
    const refusedAgain = await http.post(`/projects/${projectId}/releases/${first.id}/again`, {});
    assert.deepEqual([refusedAgain.status, refusedAgain.data.error], [409, 'the release is live, so its build cannot be released again']);
    console.log(`    ${candidate.e2e!.summary} on slot b, the same image as ${preview.commit.slice(0, 8)}; the live release cannot be released again`);

    console.log('[3b] exposing the app also exposes its preview, each on its own address');
    const deployment = (await db.getDeployments()).find((entry) => entry.gitappProjectId === projectId)!;
    const exposed = await http.post(`/deployments/${deployment.id}/expose`, { mode: 'local' });
    assert.ok(exposed.status < 300, JSON.stringify(exposed.data));
    assert.equal(exposed.data.localExposureUrl, `http://${place.namespace}.localhost:8000`);
    assert.equal(exposed.data.previewLocalUrl, `http://${place.namespace}-preview.localhost:8000`);
    const through = async (host: string, expected: RegExp): Promise<string> => {
      let page = '';
      for (let tries = 0; tries < 20; tries += 1) {
        page = await axios.get('http://localhost:8000/web/login', { headers: { Host: host }, proxy: false, timeout: 5_000, validateStatus: () => true })
          .then((answer) => String(answer.data), (err: Error) => err.message);
        if (expected.test(page)) return page;
        await sleep(1_000);
      }
      return page.slice(0, 200);
    };
    const LOGIN = /name="login"/;
    assert.match(await through(`${place.namespace}.localhost`, LOGIN), LOGIN, 'the live address does not reach an Odoo');
    assert.match(await through(`${place.namespace}-preview.localhost`, LOGIN), LOGIN, 'the preview address does not reach an Odoo');
    const listed = (await http.get(`/projects/${projectId}/releases`)).data as { addresses: { live?: string; preview?: string } };
    assert.deepEqual(listed.addresses, { live: exposed.data.localExposureUrl, preview: exposed.data.previewLocalUrl });
    console.log('    both addresses reach an Odoo through the proxy: the live one, and the preview the Ingress sends to slot b');

    console.log('[4] cutting over waits for the loss to be confirmed, then moves the project to slot b');
    const refused = await http.post(`/projects/${projectId}/releases/${candidate.id}/cut-over`, {});
    assert.equal(refused.status, 409, JSON.stringify(refused.data));
    assert.ok((refused.data as { losing?: string[] }).losing?.includes('the column koala_probe.note is dropped; 2 rows held a value in it'), JSON.stringify(refused.data));
    console.log(`    refused without a confirm: ${(refused.data as { error: string }).error}`);
    const cut = await http.post(`/projects/${projectId}/releases/${candidate.id}/cut-over`, { confirm: true });
    assert.equal(cut.status, 202, JSON.stringify(cut.data));
    await waitFor('cutover', (all) => all.find((release) => release.id === candidate.id && release.state === 'live'), 20);
    releaseIds.push(preview.id, failing.id, candidate.id);
    assert.equal(await psql('odoo_b', "select count(*) from res_users where login = 'koala-e2e'"), '0', 'the test user came along into the live database');
    assert.notEqual(await psql('odoo_b', 'select count(*) from ir_cron where active'), '0', 'the live database came over quiet');
    assert.equal(await kubectl('get', 'svc', `${place.release}-live`, '-o', 'jsonpath={.spec.selector.koala\\.dev/slot}'), 'b');
    assert.match(await columns('odoo_b'), /colour/);
    assert.doesNotMatch(await columns('odoo_b'), /\bnote\b/, 'the confirmed loss did not happen');
    assert.match(await columns('odoo_b'), /x_koala_note/, 'the field made in the app did not come along');
    assert.equal(await health(`${place.release}-live`), '200', 'the live slot does not answer after the cutover');
    assert.equal(await kubectl('get', 'deployment', `${place.release}-odoo-a`, '-o', 'jsonpath={.spec.replicas}'), '0', 'the old slot kept running, so its snapshot drifts');
    assert.match(await psql('odoo_a', `select state from ir_module_module where name = '${MODULE}'`), /installed/, 'the old slot\'s database was not kept');
    console.log('    live on slot b with its scheduled jobs and no test user; slot a is stopped with its database kept as the way back');

    console.log('[4a] rolling back returns the app to slot a exactly as it was at the cutover');
    await psql('odoo_b', "insert into koala_probe (name, create_date, write_date) values ('entered after the cutover', now(), now())");
    const offer = (await http.get(`/projects/${projectId}/releases`)).data.rollBack as { from: string; to: string; commit: string; liveSince?: string } | undefined;
    assert.deepEqual(offer && { from: offer.from, to: offer.to }, { from: candidate.id, to: first.id }, `the rollback offer is wrong: ${JSON.stringify(offer)}`);
    assert.ok(offer?.liveSince, 'the offer does not say when the cutover was');
    const back = await http.post(`/projects/${projectId}/releases/${candidate.id}/roll-back`, {});
    assert.equal(back.status, 202, JSON.stringify(back.data));
    await waitFor('rollback', (all) => (all.find((release) => release.id === first.id && release.state === 'live') && all.find((release) => release.id === candidate.id && release.state === 'rolled-back')) || undefined, 10);
    assert.equal(await kubectl('get', 'svc', `${place.release}-live`, '-o', 'jsonpath={.spec.selector.koala\\.dev/slot}'), 'a');
    assert.equal(await health(`${place.release}-live`), '200', 'the live slot does not answer after the rollback');
    assert.doesNotMatch(await columns('odoo_a'), /colour/, 'the rolled-back slot has the newer module\'s field');
    assert.equal(await psql('odoo_a', "select count(*) from koala_probe where name = 'entered after the cutover'"), '0', 'the snapshot changed after the cutover');
    assert.doesNotMatch(await kubectl('get', 'deployment', '-o', 'name'), /odoo-b/, 'the newer slot is still running');
    assert.equal((await http.get(`/projects/${projectId}/releases`)).data.rollBack, undefined, 'a second rollback is still offered');
    console.log('    live on slot a again, without the colour field or what was entered since the cutover; slot b is stopped and nothing more is offered');

    console.log('[4b] what was made in the live app is listed, brought into git by a story on the person\'s model, and kept by the next release');
    const drift = (await http.get(`/projects/${projectId}/customizations`)).data as { module: string; items: { kind: string; key: string; name: string }[] };
    assert.deepEqual(drift.items.map((item) => item.kind).sort(), ['edited-view', 'field'], JSON.stringify(drift));
    console.log(`    the live app holds ${drift.items.length} things outside git, for ${drift.module}`);
    const card = await http.post(`/projects/${projectId}/customizations/adopt`, { why: 'keep what was made in the live app' });
    assert.equal(card.status, 201, JSON.stringify(card.data));
    const approved = await http.post(`/plans/${card.data.id}/approve`, {});
    assert.ok(approved.status < 300, JSON.stringify(approved.data));
    let treeId: string | undefined;
    for (let tries = 0; tries < 120 && !treeId; tries += 1) {
      const plan = (await http.get(`/plans/${card.data.id}`)).data as { status: string; reason?: string; adopted?: { treeId: string } };
      if (plan.status === 'failed') throw new Error(`the card's plan failed: ${plan.reason}`);
      treeId = plan.adopted?.treeId;
      if (!treeId) await sleep(5_000);
    }
    assert.ok(treeId, 'the card was never adopted');
    console.log(`    the card made tree ${treeId} for the project, with the story that brings them in`);
    const storyEnded = async () => {
      const branches = ((await http.get('/branches')).data as { id: string; treeId: string }[]).filter((branch) => branch.treeId === treeId).map((branch) => branch.id);
      return ((await http.get('/leaves')).data as { branchId: string; status: string; findings?: string; landed?: { outcome: string } }[]).find((leaf) => branches.includes(leaf.branchId) && (['failed', 'cancelled'].includes(leaf.status) || (leaf.status === 'succeeded' && leaf.landed)));
    };
    let story: Awaited<ReturnType<typeof storyEnded>>;
    for (let tries = 0; tries < 720 && !story; tries += 1) {
      story = await storyEnded();
      if (!story) await sleep(10_000);
    }
    assert.equal(story?.status, 'succeeded', `the story did not ship: ${JSON.stringify(story)}`);
    assert.equal(story?.landed?.outcome, 'merged', `the story did not land: ${JSON.stringify(story?.landed)}`);
    assert.ok((await gitea.listPaths(project.giteaOwner, project.giteaRepo, 'main')).includes(`addons/${drift.module}/adopt.json`), 'the module did not land on main');
    console.log(`    the story shipped: addons/${drift.module} is on main`);
    const adopted = await waitFor('the release that brings them in', (all) => all.find((release) => release.state === 'preview' && release.e2e && release.e2e.state !== 'running' && release.changes !== undefined && !releaseIds.includes(release.id) && release.id !== first.id), 40);
    console.log(`    ${JSON.stringify({ lost: adopted.changes!.lost, items: adopted.changes!.items.map((item) => `${item.kind}: ${item.state}`) })}`);
    assert.deepEqual(adopted.changes!.items.map((item) => `${item.kind}: ${item.state}`).sort(), ['edited-view: kept', 'field: kept']);
    const adoptCut = await http.post(`/projects/${projectId}/releases/${adopted.id}/cut-over`, { confirm: true });
    assert.equal(adoptCut.status, 202, JSON.stringify(adoptCut.data));
    await waitFor('the cut-over that keeps them', (all) => all.find((release) => release.id === adopted.id && release.state === 'live'), 20);
    releaseIds.push(adopted.id);
    const liveSlot = adopted.slot === 'a' ? 'odoo_a' : 'odoo_b';
    assert.equal(await psql(liveSlot, "select count(*) from ir_model_fields where model = 'koala.probe' and name = 'x_koala_note'"), '1', 'the field made in the app is not there exactly once');
    assert.equal(await psql(liveSlot, `select count(*) from ir_model_data where model = 'ir.model.fields' and module = '${drift.module}' and res_id = (select id from ir_model_fields where model = 'koala.probe' and name = 'x_koala_note')`), '1', 'the field is not owned by the customizations module');
    assert.deepEqual((await http.get(`/projects/${projectId}/customizations`)).data.items, [], 'something brought into git still shows as made in the app');
    console.log(`    live with the field made in the app now owned by ${drift.module}, once, and no longer outside git`);

    console.log('[5] deleting the project while its app is live takes the app with it');
    const removal = (await http.get(`/projects/${projectId}/removal`)).data as { apps: string[] };
    assert.deepEqual(removal.apps, [NAME], `the deletion does not say the app goes with it: ${JSON.stringify(removal)}`);
    const removing = await http.delete(`/projects/${projectId}`, { data: { confirm: NAME } });
    assert.equal(removing.status, 202, JSON.stringify(removing.data));
    for (let tries = 0; tries < 60 && (await http.get(`/projects/${projectId}/removal`)).status !== 404; tries += 1) await sleep(5_000);
    assert.equal((await http.get(`/projects/${projectId}/removal`)).status, 404, 'the project was not deleted within five minutes');
    const gone = projectId;
    projectId = undefined;
    assert.equal(await run(KUBECTL, ['get', 'namespace', place.namespace], { env: { ...process.env, KUBECONFIG } }).then(() => true, () => false), false, 'the app\'s namespace outlived the project');
    assert.equal((await db.getDeployments()).some((entry) => entry.gitappProjectId === gone), false, 'the app\'s record outlived the project');
    const workflow = await (await getTemporalClient()).workflow.getHandle(releaseRunWorkflowId(gone)).describe();
    assert.notEqual(workflow.status.name, 'RUNNING', 'the release run outlived the project');
    console.log(`    the app, its namespace ${place.namespace} and its release run (${workflow.status.name.toLowerCase()}) went with the project`);
    if (releaseIds.length > 0) {
      let left = -1;
      for (let tries = 0; tries < 60 && left !== 0; tries += 1) {
        left = (await Promise.all(releaseIds.map((id) => db.getArtifacts(OWNER!, id)))).flat().length;
        if (left !== 0) await sleep(5_000);
      }
      assert.equal(left, 0, 'the release artifacts outlived the project');
      console.log('    the browser tests\' files went with the project');
    }
    console.log('odoo release live — PASS');
  } finally {
    if (projectId && process.env.ODOO_RELEASE_LIVE_KEEP === '1') {
      console.log(`[6] the run stopped early, and ODOO_RELEASE_LIVE_KEEP keeps what it made: project ${projectId}, namespace ${place.namespace}`);
    } else if (projectId) {
      console.log('[6] the run stopped early: removing what it made');
      const removed = await http.delete(`/projects/${projectId}`, { data: { confirm: NAME } });
      console.log(`    deleting the project, its app with it: ${removed.status} ${removed.status >= 300 ? JSON.stringify(removed.data) : ''}`);
      for (let tries = 0; tries < 60 && (await http.get(`/projects/${projectId}/removal`)).status !== 404; tries += 1) await sleep(5_000);
      const namespaceLeft = await run(KUBECTL, ['get', 'namespace', place.namespace], { env: { ...process.env, KUBECONFIG } }).then(() => true, () => false);
      console.log(`    namespace ${place.namespace} ${namespaceLeft ? 'is still there' : 'is gone'}`);
    }
    await db.close();
  }
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
