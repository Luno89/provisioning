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
import { renderStarterFiles } from '../apps/backend/src/lib/tree-types.js';
import { releasePlace } from '../apps/backend/src/lib/odoo-release.js';

const run = promisify(execFile);
const BASE = process.env.ODOO_RELEASE_LIVE_URL ?? 'http://localhost:3001/api';
const OWNER = process.env.ODOO_RELEASE_LIVE_OWNER ?? process.env.CHECKS_LIVE_OWNER ?? process.env.GROVE_LIVE_OWNER;
const CLUSTER = 'provisioning-lunorica';
const KUBECONFIG = `/tmp/kubeconfig-${CLUSTER}`;
const KUBECTL = fileURLToPath(new URL('../bin/kubectl', import.meta.url));
const NAME = `odoo-release-check-${Date.now().toString(36)}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const MODULE = 'koala_probe';
const EXTRA = 'koala_probe_extra';
const files = (entries: Record<string, string>) => Object.entries(entries).map(([path, content]) => ({ path, content }));

const PROBE = files({
  [`addons/${MODULE}/__init__.py`]: 'from . import models\n',
  [`addons/${MODULE}/__manifest__.py`]: "{\n    'name': 'Koala probe',\n    'version': '18.0.1.0.0',\n    'depends': ['base'],\n    'data': ['security/ir.model.access.csv'],\n    'license': 'LGPL-3',\n}\n",
  [`addons/${MODULE}/models/__init__.py`]: 'from . import probe\n',
  [`addons/${MODULE}/models/probe.py`]: "from odoo import fields, models\n\n\nclass Probe(models.Model):\n    _name = 'koala.probe'\n    _description = 'Koala probe'\n\n    name = fields.Char(required=True)\n",
  [`addons/${MODULE}/security/ir.model.access.csv`]: 'id,name,model_id:id,group_id:id,perm_read,perm_write,perm_create,perm_unlink\naccess_koala_probe,koala.probe,model_koala_probe,base.group_user,1,1,1,1\n',
});

const COLOUR = files({
  [`addons/${EXTRA}/__init__.py`]: 'from . import models\n',
  [`addons/${EXTRA}/__manifest__.py`]: `{\n    'name': 'Koala probe colour',\n    'version': '18.0.1.0.0',\n    'depends': ['${MODULE}'],\n    'license': 'LGPL-3',\n}\n`,
  [`addons/${EXTRA}/models/__init__.py`]: 'from . import probe\n',
  [`addons/${EXTRA}/models/probe.py`]: "from odoo import fields, models\n\n\nclass Probe(models.Model):\n    _inherit = 'koala.probe'\n\n    colour = fields.Char()\n",
});

interface Release { id: string; state: string; slot?: string; reason?: string; previewHost?: string }

async function main(): Promise<void> {
  assert.ok(OWNER, 'set ODOO_RELEASE_LIVE_OWNER (or CHECKS_LIVE_OWNER) to the person the project is made for');
  const db = createDatabase();
  await db.init();
  const user = await db.getUserById(OWNER);
  assert.ok(user, 'no such user');
  const http = axios.create({ baseURL: BASE, proxy: false, timeout: 60_000, validateStatus: () => true, headers: { Cookie: `session=${signJWT({ userId: user.id, email: user.email }, loadKeys(process.env).session, 4 * 3600)}` } });
  const gitea = new GiteaService(new InfrastructureService(), loadKeys(process.env).data, KUBECONFIG);
  const place = releasePlace(NAME);
  const kubectl = async (...args: string[]) => (await run(KUBECTL, ['-n', place.namespace, ...args], { env: { ...process.env, KUBECONFIG } })).stdout.trim();
  const psql = (database: string, sql: string) => kubectl('exec', `${place.release}-postgres-0`, '--', 'psql', '-U', 'odoo', '-d', database, '-tAc', sql);
  const columns = (database: string) => psql(database, "select column_name from information_schema.columns where table_name = 'koala_probe' order by 1");
  const health = async (service: string): Promise<string> => {
    const answer = await run(KUBECTL, ['get', '--raw', `/api/v1/namespaces/${place.namespace}/services/http:${service}:8069/proxy/web/health`], { env: { ...process.env, KUBECONFIG } })
      .then((out) => out.stdout, (err: Error) => err.message);
    return /"status"\s*:\s*"pass"/.test(answer) ? '200' : answer.trim().slice(0, 200);
  };

  let projectId: string | undefined;
  try {
    console.log(`[1] a project on the system cluster: ${NAME}`);
    const made = await http.post('/projects', { name: NAME, giteaRepo: NAME, createRepo: true, targetClusterId: CLUSTER });
    assert.ok(made.status < 300, JSON.stringify(made.data));
    const project = made.data as { id: string; giteaOwner: string; giteaRepo: string };
    projectId = project.id;

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
    await gitea.seedTemplate(project.giteaOwner, project.giteaRepo, [...renderStarterFiles(ODOO_ADDONS_FILES, { projectName: NAME, registryHost: await gitea.getRegistryHost() }), ...PROBE]);
    const first = await waitFor('first release', (all) => all.find((release) => release.state === 'live'), 30);
    assert.equal(first.slot, 'a');
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
    const cut = await http.post(`/projects/${projectId}/releases/${preview.id}/cut-over`, {});
    assert.equal(cut.status, 202, JSON.stringify(cut.data));
    await waitFor('cutover', (all) => all.find((release) => release.id === preview.id && release.state === 'live'), 20);
    assert.equal(await kubectl('get', 'svc', `${place.release}-live`, '-o', 'jsonpath={.spec.selector.koala\\.dev/slot}'), 'b');
    assert.match(await columns('odoo_b'), /colour/);
    assert.equal(await health(`${place.release}-live`), '200', 'the live slot does not answer after the cutover');
    assert.equal(await health(`${place.release}-odoo-a`), '200', 'the old slot is not kept as the way back');
    console.log('    live on slot b, and slot a is kept as the way back');
    console.log('odoo release live — PASS');
  } finally {
    if (projectId) {
      console.log('[5] removing what it made');
      const deployment = (await db.getDeployments()).find((entry) => entry.gitappProjectId === projectId);
      if (deployment?.isExposedLocally) console.log(`    unexposing: ${(await http.post(`/deployments/${deployment.id}/unexpose`, { mode: 'local' })).status}`);
      if (deployment) {
        const destroyed = await http.delete(`/deployments/${deployment.id}`);
        console.log(`    destroying the app: ${destroyed.status}`);
        for (let tries = 0; tries < 60; tries += 1) {
          if (!(await db.getDeployments()).some((entry) => entry.id === deployment.id && entry.status !== 'destroyed')) break;
          await sleep(5_000);
        }
      }
      const namespaceLeft = await run(KUBECTL, ['get', 'namespace', place.namespace], { env: { ...process.env, KUBECONFIG } }).then(() => true, () => false);
      console.log(`    namespace ${place.namespace} ${namespaceLeft ? 'is still there — removing it directly' : 'is gone'}`);
      if (namespaceLeft) {
        await run(fileURLToPath(new URL('../bin/helm', import.meta.url)), ['uninstall', place.release, '-n', place.namespace, '--ignore-not-found'], { env: { ...process.env, KUBECONFIG } }).catch(() => undefined);
        await run(KUBECTL, ['delete', 'namespace', place.namespace, '--ignore-not-found', '--wait=true', '--timeout=180s'], { env: { ...process.env, KUBECONFIG } }).catch(() => undefined);
      }
      const removed = await http.delete(`/projects/${projectId}`, { data: { confirm: NAME } });
      console.log(`    deleting the project: ${removed.status} ${removed.status >= 300 ? JSON.stringify(removed.data) : ''}`);
    }
    await db.close();
  }
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
