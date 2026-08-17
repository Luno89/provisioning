/**
 * The skeleton a new repository starts from, chosen by what the tree is for.
 *
 * ── WHY THIS EXISTS ──
 * Every project started empty, so the first leaf spent its budget rediscovering the same things —
 * and getting them wrong in the same ways. Measured, all in one effort:
 *
 *   - No Dockerfile, so the pipeline had nothing to build. It then retried 622 times.
 *   - No .gitignore, so `npm install` committed node_modules and poisoned the project's memory.
 *   - Nothing read `process.env.PORT`, so the deployed container decided it was not a service,
 *     fell back to stdio, and exited 0 in a restart loop.
 *   - The agent hunted for a test runner and reached for jest against a registry it could not
 *     reach.
 *
 * None of those are interesting problems and all of them are the same problem: the first leaf is
 * asked to invent a shape that is identical every time. A template is that shape, written once.
 *
 * ── WHAT A TEMPLATE IS NOT ──
 * It is not the work. It is the smallest thing that already builds, already runs and already has
 * somewhere to put a test — so the first leaf edits something that works rather than assembling
 * something that might. Nothing here is application logic.
 *
 * ── AND WHY IT IS KEYED ON THE TREE TYPE ──
 * The tree already declares what done means for the effort — `api-service` says "it builds, it
 * deploys, and the endpoint responds". That is precisely the sentence this file makes true on day
 * one, so the two belong to the same decision rather than being a second thing to pick.
 */

export interface TemplateFile {
  path: string;
  content: string;
}

/**
 * Where base images come from.
 *
 * ── WHY NOT DOCKER HUB ──
 * Every build pulled `node:22-alpine` anonymously from Docker Hub, and Docker Hub rate-limits
 * anonymous pulls per source IP. A cluster is one IP, so a handful of builds in an afternoon is
 * enough: `TOOMANYREQUESTS: You have reached your unauthenticated pull rate limit`, and every
 * build fails at the first instruction with an error that has nothing to do with the code.
 *
 * The same reasoning as the in-cluster npm mirror. A build that depends on an unauthenticated
 * third party is a build that stops working on somebody else's schedule.
 *
 * Mirrored with: skopeo copy docker://docker.io/library/node:22-alpine docker://<registry>/provisioning-bot/node:22-alpine
 */
export const MIRROR_NAMESPACE = 'provisioning-bot';

/** The mirrored base for a given registry, or Docker Hub's name when there is no registry yet. */
export function nodeBaseImage(registryHost?: string): string {
  return registryHost ? `${registryHost}/${MIRROR_NAMESPACE}/node:22-alpine` : 'node:22-alpine';
}

/** Node 22 is what the workspace image ships; the runtime has a test runner and fetch built in. */
const NODE_DOCKERFILE = (base: string) => [
  '# This Dockerfile already works. Change it only if you add dependencies or build steps.',
  '#',
  '# It is deliberately single-stage. A multi-stage build that copies node_modules out of an',
  '# install stage FAILS on a project with no dependencies — npm installs nothing, the directory',
  '# never exists, and the error names a path inside the builder rather than the cause.',
  '# Measured: three separate build failures from one rewrite of this file.',
  // Mirrored in-cluster, not Docker Hub — see nodeBaseImage. Changing this back to a Docker Hub
  // name will build a handful of times and then start failing on the anonymous pull limit.
  `FROM ${base}`,
  'WORKDIR /app',
  'COPY . .',
  '# Installs only if there is something to install, so a dependency-free project stays fast.',
  'RUN if [ -f package-lock.json ]; then npm ci --omit=dev; fi',
  '# The platform injects PORT; EXPOSE is documentation, not a binding.',
  'EXPOSE 8080',
  'CMD ["node", "src/server.js"]',
  '',
].join('\n');

/**
 * A server that is already the right shape.
 *
 * Reads PORT, answers /health, and says out loud why both matter — the deployment's readiness probe
 * is a TCP check against that port, and a container that binds somewhere else looks like a broken
 * application rather than a misconfigured one.
 */
const NODE_SERVER = [
  "import { createServer } from 'node:http';",
  '',
  '/**',
  ' * The port comes from the environment.',
  ' *',
  " * The deployment sets PORT and probes it. Binding a hardcoded port instead is the difference",
  ' * between a service that comes up and one that restarts forever.',
  ' */',
  'const port = Number(process.env.PORT) || 8080;',
  '',
  'export const server = createServer((req, res) => {',
  '  // A health endpoint from the first commit, so "is it up" is answerable before there is',
  '  // anything else to ask.',
  "  if (req.url === '/health') {",
  "    res.writeHead(200, { 'content-type': 'application/json' });",
  "    return res.end(JSON.stringify({ status: 'ok' }));",
  '  }',
  "  res.writeHead(404, { 'content-type': 'application/json' });",
  "  res.end(JSON.stringify({ error: 'Not found' }));",
  '});',
  '',
  '// Not started on import, so a test can bind an ephemeral port instead.',
  'if (process.argv[1]?.endsWith("server.js")) {',
  '  server.listen(port, () => console.log(`listening on ${port}`));',
  '}',
  '',
].join('\n');

const NODE_TEST = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert';",
  "import { server } from '../src/server.js';",
  '',
  '// Port 0 lets the OS choose, so tests never collide with anything already listening.',
  "test('health endpoint answers', async () => {",
  '  await new Promise((resolve) => server.listen(0, resolve));',
  '  const { port } = server.address();',
  '  const res = await fetch(`http://127.0.0.1:${port}/health`);',
  '  assert.strictEqual(res.status, 200);',
  "  assert.deepStrictEqual(await res.json(), { status: 'ok' });",
  '  server.close();',
  '});',
  '',
].join('\n');

const NODE_PACKAGE = (name: string) => `${JSON.stringify({
  name,
  version: '0.1.0',
  private: true,
  type: 'module',
  main: 'src/server.js',
  // The runtime's own runner. There is a package registry in the cluster, but a project that needs
  // nothing installed to run its tests is one less thing that can fail.
  scripts: { test: 'node --test test/*.test.js', start: 'node src/server.js' },
}, null, 2)}\n`;

const README = (name: string, kind: string) => [
  `# ${name}`,
  '',
  `A ${kind} scaffolded by Koala.`,
  '',
  '## Running it',
  '',
  '```sh',
  'npm test      # node --test',
  'npm start     # listens on $PORT, default 8080',
  '```',
  '',
  'Pushing to the default branch builds an image and deploys it. `/health` is what the',
  'deployment checks.',
  '',
].join('\n');

/**
 * The skeleton for a tree type, or nothing.
 *
 * Deliberately absent for most types. A research tree has no repository, and a migration or an
 * investigation works on code that already exists — dropping a server skeleton into either would be
 * noise the first leaf has to delete.
 */
export function templateFor(
  treeType: string | undefined,
  projectName: string,
  /** The in-cluster registry, so the scaffold does not depend on Docker Hub. */
  registryHost?: string,
): TemplateFile[] {
  switch (treeType) {
    case 'api-service':
      return [
        { path: 'Dockerfile', content: NODE_DOCKERFILE(nodeBaseImage(registryHost)) },
        { path: 'package.json', content: NODE_PACKAGE(projectName) },
        { path: 'src/server.js', content: NODE_SERVER },
        { path: 'test/server.test.js', content: NODE_TEST },
        { path: 'README.md', content: README(projectName, 'service') },
      ];
    case 'library':
      // No Dockerfile and no server: a library is not deployed, and giving it one would have the
      // pipeline build an image nobody wants.
      return [
        { path: 'package.json', content: NODE_PACKAGE(projectName) },
        { path: 'README.md', content: README(projectName, 'library') },
      ];
    default:
      return [];
  }
}

/** Which tree types start from something. Used to say so in the UI rather than surprising anyone. */
export const TEMPLATED_TREE_TYPES = ['api-service', 'library'];
