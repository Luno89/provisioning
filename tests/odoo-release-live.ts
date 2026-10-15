import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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
import { newReleaseName, releasePlace, releaseWorkflowId } from '../apps/backend/src/lib/odoo-release.js';
import { getTemporalClient } from '../apps/backend/src/lib/temporal-client.js';
import { labelValue } from '../apps/backend/src/engine-host/sandboxes/workspace.js';

const run = promisify(execFile);
const BASE = process.env.ODOO_RELEASE_LIVE_URL ?? 'http://localhost:3001/api';
const OWNER = process.env.ODOO_RELEASE_LIVE_OWNER ?? process.env.CHECKS_LIVE_OWNER ?? process.env.GROVE_LIVE_OWNER;
const CLUSTER = 'provisioning-lunorica';
const KUBECONFIG = `/tmp/kubeconfig-${CLUSTER}`;
const KUBECTL = fileURLToPath(new URL('../bin/kubectl', import.meta.url));
const NAME = `odoo-release-check-${Date.now().toString(36)}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ODOO_TYPE = TREE_TYPE_SEEDS.find((type) => type.id === ODOO_TREE_TYPE)!;
const ODOO_VERSION = versionVars(ODOO_TYPE, { version: ODOO_TYPE.versions?.default });
const MODULE = 'koala_probe';
const EXTRA = 'koala_probe_extra';
const files = (entries: Record<string, string>) => Object.entries(entries).map(([path, content]) => ({ path, content }));

const PROBE = files({
  [`addons/${MODULE}/__init__.py`]: 'from . import models\n',
  [`addons/${MODULE}/__manifest__.py`]: `{\n    'name': 'Koala probe',\n    'version': '${ODOO_VERSION.version}.0.1.0.0',\n    'depends': ['base'],\n    'data': ['security/ir.access.csv'],\n    'license': 'LGPL-3',\n}\n`,
  [`addons/${MODULE}/models/__init__.py`]: 'from . import probe\n',
  [`addons/${MODULE}/models/probe.py`]: "from odoo import fields, models\n\n\nclass Probe(models.Model):\n    _name = 'koala.probe'\n    _description = 'Koala probe'\n\n    name = fields.Char(required=True)\n",
  [`addons/${MODULE}/security/ir.access.csv`]: 'id,name,model_id,group_id/id,operation,domain\naccess_koala_probe,koala.probe,koala.probe,base.group_user,crud,\n',
});

const COLOUR = files({
  [`addons/${EXTRA}/__init__.py`]: 'from . import models\n',
  [`addons/${EXTRA}/__manifest__.py`]: `{\n    'name': 'Koala probe colour',\n    'version': '${ODOO_VERSION.version}.0.1.0.0',\n    'depends': ['${MODULE}'],\n    'license': 'LGPL-3',\n}\n`,
  [`addons/${EXTRA}/models/__init__.py`]: 'from . import probe\n',
  [`addons/${EXTRA}/models/probe.py`]: "from odoo import fields, models\n\n\nclass Probe(models.Model):\n    _inherit = 'koala.probe'\n\n    colour = fields.Char()\n",
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
interface Release { id: string; state: string; slot?: string; reason?: string; previewHost?: string; e2e?: BrowserTests }

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

    console.log('[3] a new module adds a field: the next build is prepared in slot b and waits in preview');
    await gitea.seedTemplate(project.giteaOwner, project.giteaRepo, COLOUR);
    const preview = await waitFor('preview', (all) => all.find((release) => release.state === 'preview'), 30);
    assert.equal(preview.slot, 'b');
    assert.match(await columns('odoo_b'), /colour/, 'slot b\'s copy has no colour column');
    assert.doesNotMatch(await columns('odoo_a'), /colour/, 'the live database changed before the cutover');
    assert.equal(await kubectl('get', 'svc', `${place.release}-live`, '-o', 'jsonpath={.spec.selector.koala\\.dev/slot}'), 'a');
    assert.equal(await health(`${place.release}-odoo-b`), '200', 'the preview slot does not answer');
    assert.match(await kubectl('get', 'ingress', 'app', '-o', 'jsonpath={.spec.rules[*].host}'), new RegExp(place.previewHost.replace(/\./g, '\\.')));
    console.log('    preview on slot b: it has the colour field, the live slot does not');

    console.log('[3a] the preview is quiet, and passes the project\'s browser tests signed in as its own test user');
    assert.equal(await psql('odoo_b', 'select count(*) from ir_cron where active'), '0', 'the preview still runs scheduled jobs');
    assert.equal(await psql('odoo_b', 'select count(*) from ir_mail_server where active'), '0', 'the preview can still send mail');
    assert.notEqual(await psql('odoo_a', 'select count(*) from ir_cron where active'), '0', 'the live database lost its scheduled jobs');
    const tested = await waitFor('browser tests on the preview', (all) => all.find((release) => release.id === preview.id && release.e2e && release.e2e.state !== 'running'), 15);
    assert.equal(tested.e2e!.state, 'passed', JSON.stringify(tested.e2e));
    assert.equal(tested.e2e!.summary, '1 passed, 0 failed');
    assert.deepEqual(tested.e2e!.tests!.map((test) => [test.title, test.status]), [['a person signs in and reaches the Odoo home', 'passed']]);
    assert.equal(await psql('odoo_b', "select count(*) from res_users where login = 'koala-e2e' and active"), '1', 'the preview has no test user');
    assert.equal(await psql('odoo_a', "select count(*) from res_users where login = 'koala-e2e'"), '0', 'the test user reached the live database');
    assert.equal(await kubectl('get', 'jobs', '-l', 'app.kubernetes.io/component=e2e', '-o', 'name').then((out) => out.split('\n').filter((line) => line.includes('/' + place.release + '-e2e')).filter((line) => !line.includes('login')).length), 0, 'the browser job was left behind');
    console.log(`    ${tested.e2e!.summary}: the sign-in test passed in the preview as koala-e2e; slot a has no such user`);

    console.log('[3c] a spec that cannot pass: the next preview shows the failure and what the browser saw, and still offers the cutover');
    await gitea.seedTemplate(project.giteaOwner, project.giteaRepo, FAILING);
    const failing = await waitFor('the failing preview\'s browser tests', (all) => all.find((release) => release.id !== preview.id && release.state === 'preview' && release.e2e && release.e2e.state !== 'running'), 30);
    assert.equal((await releases()).find((release) => release.id === preview.id)?.state, 'superseded');
    assert.equal(failing.e2e!.state, 'failed', JSON.stringify(failing.e2e));
    assert.equal(failing.e2e!.summary, '1 passed, 1 failed');
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

    console.log('[4] cutting over moves the project to slot b');
    const cut = await http.post(`/projects/${projectId}/releases/${failing.id}/cut-over`, {});
    assert.equal(cut.status, 202, JSON.stringify(cut.data));
    await waitFor('cutover', (all) => all.find((release) => release.id === failing.id && release.state === 'live'), 20);
    releaseIds.push(preview.id, failing.id);
    assert.equal(await psql('odoo_b', "select count(*) from res_users where login = 'koala-e2e'"), '0', 'the test user came along into the live database');
    assert.notEqual(await psql('odoo_b', 'select count(*) from ir_cron where active'), '0', 'the live database came over quiet');
    assert.equal(await kubectl('get', 'svc', `${place.release}-live`, '-o', 'jsonpath={.spec.selector.koala\\.dev/slot}'), 'b');
    assert.match(await columns('odoo_b'), /colour/);
    assert.equal(await health(`${place.release}-live`), '200', 'the live slot does not answer after the cutover');
    assert.equal(await kubectl('get', 'deployment', `${place.release}-odoo-a`, '-o', 'jsonpath={.spec.replicas}'), '0', 'the old slot kept running, so its snapshot drifts');
    assert.match(await psql('odoo_a', `select state from ir_module_module where name = '${MODULE}'`), /installed/, 'the old slot\'s database was not kept');
    console.log('    live on slot b with its scheduled jobs and no test user; slot a is stopped with its database kept as the way back');

    console.log('[4a] rolling back returns the app to slot a exactly as it was at the cutover');
    await psql('odoo_b', "insert into koala_probe (name, create_date, write_date) values ('entered after the cutover', now(), now())");
    const offer = (await http.get(`/projects/${projectId}/releases`)).data.rollBack as { from: string; to: string; commit: string; liveSince?: string } | undefined;
    assert.deepEqual(offer && { from: offer.from, to: offer.to }, { from: failing.id, to: first.id }, `the rollback offer is wrong: ${JSON.stringify(offer)}`);
    assert.ok(offer?.liveSince, 'the offer does not say when the cutover was');
    const back = await http.post(`/projects/${projectId}/releases/${failing.id}/roll-back`, {});
    assert.equal(back.status, 202, JSON.stringify(back.data));
    await waitFor('rollback', (all) => (all.find((release) => release.id === first.id && release.state === 'live') && all.find((release) => release.id === failing.id && release.state === 'rolled-back')) || undefined, 10);
    assert.equal(await kubectl('get', 'svc', `${place.release}-live`, '-o', 'jsonpath={.spec.selector.koala\\.dev/slot}'), 'a');
    assert.equal(await health(`${place.release}-live`), '200', 'the live slot does not answer after the rollback');
    assert.doesNotMatch(await columns('odoo_a'), /colour/, 'the rolled-back slot has the newer module\'s field');
    assert.equal(await psql('odoo_a', "select count(*) from koala_probe where name = 'entered after the cutover'"), '0', 'the snapshot changed after the cutover');
    assert.doesNotMatch(await kubectl('get', 'deployment', '-o', 'name'), /odoo-b/, 'the newer slot is still running');
    assert.equal((await http.get(`/projects/${projectId}/releases`)).data.rollBack, undefined, 'a second rollback is still offered');
    console.log('    live on slot a again, without the colour field or what was entered since the cutover; slot b is stopped and nothing more is offered');

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
    const workflow = await (await getTemporalClient()).workflow.getHandle(releaseWorkflowId(gone)).describe();
    assert.notEqual(workflow.status.name, 'RUNNING', 'the release workflow outlived the project');
    console.log(`    the app, its namespace ${place.namespace} and its release workflow (${workflow.status.name.toLowerCase()}) went with the project`);
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
    if (projectId) {
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
