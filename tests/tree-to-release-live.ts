import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)) });
import axios from 'axios';
import { createDatabase } from '../apps/backend/src/platform/lib/db-interface.js';
import { signJWT } from '../apps/backend/src/platform/lib/auth.js';
import { loadKeys } from '../apps/backend/src/platform/lib/keys.js';
import { GiteaService } from '../apps/backend/src/projects/services/GiteaService.js';
import { InfrastructureService } from '../apps/backend/src/infrastructure/services/InfrastructureService.js';
import { releasePlace } from '../apps/backend/src/releases/lib/odoo-release.js';

const run = promisify(execFile);
const BASE = process.env.TREE_LIVE_URL ?? 'http://localhost:3001/api';
const OWNER = process.env.TREE_LIVE_OWNER ?? process.env.ODOO_RELEASE_LIVE_OWNER ?? process.env.CHECKS_LIVE_OWNER;
const CLUSTER = 'provisioning-lunorica';
const KUBECONFIG = `/tmp/kubeconfig-${CLUSTER}`;
const KUBECTL = fileURLToPath(new URL('../bin/kubectl', import.meta.url));
const STAMP = Date.now().toString(36);
const ODOO = `tree-odoo-${STAMP}`;
const API = `tree-api-${STAMP}`;
const PAPER = `tree-paper-${STAMP}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Tree { id: string; name: string; type: string; projectIds?: string[] }
interface Project { id: string; name: string; giteaOwner?: string; giteaRepo?: string; targetClusterId?: string; autoDeployOnBuild?: boolean; language?: string; webhookSecretEnc?: string; releaseName?: string; requiredSecrets?: { key: string; source: string }[] }

async function main(): Promise<void> {
  assert.ok(OWNER, 'set TREE_LIVE_OWNER (or ODOO_RELEASE_LIVE_OWNER) to the person the trees are made for');
  const db = createDatabase();
  await db.init();
  const user = await db.accounts.getUserById(OWNER);
  assert.ok(user, 'no such user');
  const http = axios.create({ baseURL: BASE, proxy: false, timeout: 60_000, validateStatus: () => true, headers: { Cookie: `session=${signJWT({ userId: user.id, email: user.email }, loadKeys(process.env).session, 4 * 3600)}` } });
  const gitea = new GiteaService(new InfrastructureService(), loadKeys(process.env).data, KUBECONFIG);
  const kubectl = async (namespace: string, ...args: string[]) => (await run(KUBECTL, ['-n', namespace, ...args], { env: { ...process.env, KUBECONFIG } })).stdout.trim();
  const projectOf = async (id: string): Promise<Project> => {
    const found = (await db.projects.getProjects()).find((entry) => entry.id === id) as Project | undefined;
    assert.ok(found, `there is no project ${id}`);
    return found;
  };
  const waitFor = async <T>(what: string, minutes: number, probe: () => Promise<T | undefined>): Promise<T> => {
    const until = Date.now() + minutes * 60_000;
    while (Date.now() < until) {
      const found = await probe();
      if (found !== undefined) return found;
      await sleep(10_000);
    }
    throw new Error(`no ${what} within ${minutes} minutes`);
  };
  const runsOf = async (projectId: string) => (await http.get(`/projects/${projectId}/runs`)).data as { status: string; imageTag?: string; errorMessage?: string; releaseRefused?: string }[];
  const madeProjects: Project[] = [];
  const madeTrees: string[] = [];
  let odooRelease: string | undefined;

  const newTree = async (name: string, type: string): Promise<Tree> => {
    const made = await http.post('/trees', { name, type, goal: `the ${type} the tree-to-release check makes` });
    assert.equal(made.status, 201, JSON.stringify(made.data));
    madeTrees.push(made.data.id);
    return made.data as Tree;
  };

  const homed = async (tree: Tree, files: string[]): Promise<Project> => {
    assert.equal(tree.projectIds?.length, 1, `the ${tree.type} tree has no project: ${JSON.stringify(tree.projectIds)}`);
    const project = await projectOf(tree.projectIds![0]!);
    madeProjects.push(project);
    assert.equal(project.name, tree.name);
    assert.ok(project.giteaOwner && project.giteaRepo, 'the project has no repository');
    assert.ok(project.webhookSecretEnc, 'the project has no build webhook');
    assert.equal(project.targetClusterId, CLUSTER, 'the project does not deploy to the person\'s own cluster');
    assert.equal(project.autoDeployOnBuild, true, 'the project does not deploy itself');
    const branch = await gitea.inspectBranch(project.giteaOwner!, project.giteaRepo!, 'main', files);
    assert.deepEqual(branch.missing, [], `the repository lacks the type's starter files: ${branch.missing.join(', ')}`);
    return project;
  };

  try {
    console.log(`[1] a new Odoo tree, made the way the New Tree dialog makes one, gets a project of its own: ${ODOO}`);
    const odoo = await homed(await newTree(ODOO, 'odoo-addons'), ['Dockerfile', 'CHECKS.md', 'deploy/chart/Chart.yaml', 'e2e/signs-in.spec.ts']);
    console.log(`    project ${odoo.id}: ${odoo.giteaOwner}/${odoo.giteaRepo}, webhook, cluster ${CLUSTER}, deploys itself, starter on main`);

    console.log('[2] its starter builds and is released into slot a with nobody touching it');
    const live = await waitFor('live release', 30, async () => {
      const runs = await runsOf(odoo.id);
      const broken = runs.find((entry) => entry.status === 'failed' || entry.releaseRefused);
      if (broken) throw new Error(`the starter's build did not reach a release: ${broken.errorMessage ?? broken.releaseRefused}`);
      const releases = (await http.get(`/projects/${odoo.id}/releases`)).data.releases as { state: string; slot?: string; reason?: string }[];
      const failed = releases.find((entry) => entry.state === 'failed');
      if (failed) throw new Error(`the release failed: ${failed.reason}`);
      return releases.find((entry) => entry.state === 'live');
    });
    assert.equal(live.slot, 'a');
    const released = (await db.projects.getProjects()).find((entry) => entry.id === odoo.id) as Project | undefined;
    assert.ok(released?.releaseName, 'the project keeps no release name');
    const place = releasePlace(released.releaseName);
    odooRelease = place.namespace;
    const health = await run(KUBECTL, ['get', '--raw', `/api/v1/namespaces/${place.namespace}/services/http:${place.release}-live:8069/proxy/web/health`], { env: { ...process.env, KUBECONFIG } }).then((out) => out.stdout, (err: Error) => err.message);
    assert.match(health, /"status"\s*:\s*"pass"/, `the live Odoo does not answer: ${health.slice(0, 200)}`);
    console.log('    live in slot a, and its Odoo answers');

    console.log('[2a] its secrets live in the project\'s vault: the database and admin passwords were made for it, reach the app, and sign the person in');
    assert.deepEqual(released.requiredSecrets, [{ key: 'POSTGRES_PASSWORD', source: 'generated' }, { key: 'ODOO_ADMIN_PASSWORD', source: 'generated' }], `the project does not record the type's secrets: ${JSON.stringify(released.requiredSecrets)}`);
    const synced = JSON.parse((await kubectl(place.namespace, 'get', 'secret', `${place.release}-vault`, '-o', 'jsonpath={.data}')) || '{}') as Record<string, string>;
    assert.deepEqual(Object.keys(synced).sort(), ['ODOO_ADMIN_PASSWORD', 'POSTGRES_PASSWORD'], 'the vault did not reach the app\'s namespace');
    assert.equal(await kubectl(place.namespace, 'get', 'secret', `${place.release}-secrets`).then(() => true, () => false), false, 'the chart still made a secret of its own');
    const signIn = (await http.get(`/projects/${odoo.id}/sign-in`)).data.signIns as { login: string; password: string }[];
    assert.equal(signIn.length, 1, `the app offers no sign-in: ${signIn.length}`);
    assert.equal(signIn[0]!.login, 'admin');
    assert.match(signIn[0]!.password, /^[A-Za-z0-9]{32}$/, 'the admin password is not one the platform made');
    const signsIn = async (password: string) => (await kubectl(place.namespace, 'exec', `deploy/${place.release}-odoo-a`, '--', 'python3', '-c',
      'import sys, xmlrpc.client; print(xmlrpc.client.ServerProxy("http://localhost:8069/xmlrpc/2/common").authenticate("odoo_a", "admin", sys.argv[1], {}))', password)).trim();
    assert.equal(await signsIn(signIn[0]!.password), '2', 'Odoo does not accept the admin password from the vault');
    assert.equal(await signsIn('admin'), 'False', 'Odoo still accepts admin/admin');
    console.log('    the vault holds both, the app\'s namespace has them, and Odoo signs admin in with the shown password and refuses admin/admin');

    console.log('[2b] a push that only changes the README builds, but releases nothing, and the build says why');
    const readme = (await http.get(`/projects/${odoo.id}/files/content`, { params: { path: 'README.md' } })).data as { content: string; sha: string };
    const edited = await http.put(`/projects/${odoo.id}/files/content`, { path: 'README.md', content: `${readme.content}\nA line about nothing the app is built from.\n`, sha: readme.sha });
    assert.equal(edited.status, 200, JSON.stringify(edited.data));
    const releasesBefore = ((await http.get(`/projects/${odoo.id}/releases`)).data.releases as unknown[]).length;
    const docsBuild = await waitFor('the README build', 15, async () => {
      const latest = (await db.getPipelineRuns()).filter((entry) => entry.projectId === odoo.id).sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))[0];
      if (latest?.status === 'failed') throw new Error(`the README build failed: ${latest.errorMessage}`);
      return latest && latest.status === 'succeeded' && latest.releaseSkipped ? latest : undefined;
    });
    assert.match(docsBuild.releaseSkipped ?? '', /^only README\.md changed since [0-9a-f]{8}, none of which the app is built from$/);
    await sleep(15_000);
    assert.equal(((await http.get(`/projects/${odoo.id}/releases`)).data.releases as unknown[]).length, releasesBefore, 'the README build made a release');
    console.log(`    built ${docsBuild.commitSha?.slice(0, 8)}; nothing to release: ${docsBuild.releaseSkipped}`);

    console.log(`[3] a new API tree gets a project too, and its starter builds and deploys: ${API}`);
    const api = await homed(await newTree(API, 'api-service'), ['Dockerfile', 'package.json', 'src/server.js']);
    const deployed = await waitFor('running deployment', 15, async () => {
      const runs = await runsOf(api.id);
      const broken = runs.find((entry) => entry.status === 'failed');
      if (broken) throw new Error(`the API starter's build failed: ${broken.errorMessage}`);
      const deployment = (await db.getDeployments()).find((entry) => entry.gitappProjectId === api.id);
      if (deployment?.status === 'failed' || deployment?.status === 'unhealthy') throw new Error(`the API's deployment is ${deployment.status}: ${deployment.healthReason ?? ''}`);
      return deployment?.status === 'running' ? deployment : undefined;
    });
    console.log(`    built and running as ${deployed.name} on ${deployed.clusterId}`);

    console.log(`[4] a research paper tree is an answer, not a service: it gets no project: ${PAPER}`);
    const paper = await newTree(PAPER, 'research-paper');
    assert.deepEqual(paper.projectIds ?? [], [], 'a paper tree was given a project');
    assert.equal((await db.projects.getProjects()).some((entry) => entry.name === PAPER), false);
    console.log('    no project, no repository, nothing to build');
    console.log('tree to release live — PASS');
  } finally {
    console.log('[5] removing what it made');
    for (const project of madeProjects) {
      const deployment = (await db.getDeployments()).find((entry) => entry.gitappProjectId === project.id);
      if (deployment) {
        console.log(`    destroying ${deployment.name}: ${(await http.delete(`/deployments/${deployment.id}`)).status}`);
        for (let tries = 0; tries < 60; tries += 1) {
          if (!(await db.getDeployments()).some((entry) => entry.id === deployment.id && entry.status !== 'destroyed')) break;
          await sleep(5_000);
        }
      }
      const removed = await http.delete(`/projects/${project.id}`, { data: { confirm: project.name } });
      console.log(`    deleting project ${project.name}: ${removed.status}${removed.status >= 300 ? ` ${JSON.stringify(removed.data)}` : ''}`);
    }
    for (let tries = 0; tries < 60; tries += 1) {
      const left = (await db.projects.getProjects()).filter((entry) => madeProjects.some((made) => made.id === entry.id));
      if (left.length === 0) break;
      await sleep(5_000);
    }
    for (const id of madeTrees) {
      if ((await db.projects.getTrees()).some((tree) => tree.id === id)) {
        const gone = await http.delete(`/trees/${id}`);
        console.log(`    deleting tree ${id}: ${gone.status}`);
      }
    }
    const namespace = odooRelease ?? releasePlace(ODOO).namespace;
    const namespaceLeft = await kubectl(namespace, 'get', 'namespace', namespace).then(() => true, () => false);
    console.log(`    namespace ${namespace} ${namespaceLeft ? 'is still there' : 'is gone'}`);
    await db.close();
  }
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
