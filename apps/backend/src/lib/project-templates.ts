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

const MCP_SERVER = `import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

/**
 * The tools this server offers.
 *
 * Add to this list and the server advertises them; nothing else needs changing. \`inputSchema\` is
 * JSON Schema, which is what a caller reads to know how to call the tool.
 */
const TOOLS = [
  {
    name: 'echo',
    description: 'Returns whatever it is given. Replace this with a real tool.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Anything at all.' } },
      required: ['message'],
    },
    run: async ({ message }) => \`You said: \${message}\`,
  },
];

const PROTOCOL_VERSION = '2025-06-18';

/** A JSON-RPC reply. Every response is 200 — errors travel in the body, per JSON-RPC. */
const reply = (res, id, payload, sessionId) => {
  res.writeHead(200, {
    'content-type': 'application/json',
    // Streamable HTTP is not stateless: the client sends this back on every later call.
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  });
  res.end(JSON.stringify({ jsonrpc: '2.0', id, ...payload }));
};

const server = createServer(async (req, res) => {
  // The platform probes this to decide whether the deployment is healthy.
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok' }));
  }

  if (req.url !== '/mcp' || req.method !== 'POST') {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Not found' }));
  }

  let body = '';
  for await (const chunk of req) body += chunk;

  let message;
  try {
    message = JSON.parse(body);
  } catch {
    return reply(res, 0, { error: { code: -32700, message: 'Parse error' } });
  }
  const id = message.id ?? 0;

  if (message.method === 'initialize') {
    return reply(res, id, {
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'NAME_PLACEHOLDER', version: '0.1.0' },
      },
    }, randomUUID());
  }

  if (message.method === 'tools/list') {
    // Without \`run\`, which is this server's business and not the caller's.
    return reply(res, id, {
      result: { tools: TOOLS.map(({ run, ...tool }) => tool) },
    });
  }

  if (message.method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === message.params?.name);
    if (!tool) {
      return reply(res, id, { error: { code: -32602, message: \`No tool named "\${message.params?.name}"\` } });
    }
    try {
      const text = await tool.run(message.params?.arguments ?? {});
      // Content is an ARRAY of typed parts; a caller joins the text ones.
      return reply(res, id, { result: { content: [{ type: 'text', text: String(text) }] } });
    } catch (err) {
      // isError rather than a JSON-RPC error: the call reached the tool and the tool failed, which
      // is something the caller can act on.
      return reply(res, id, {
        result: { content: [{ type: 'text', text: String(err?.message ?? err) }], isError: true },
      });
    }
  }

  // A notification has no id and expects no reply.
  if (id === 0 && message.method?.startsWith('notifications/')) {
    res.writeHead(202);
    return res.end();
  }

  return reply(res, id, { error: { code: -32601, message: \`Unknown method "\${message.method}"\` } });
});

// PORT decides whether this is a service at all: a server that ignores it binds the wrong port,
// the readiness probe never passes, and the deployment restarts forever.
const port = Number(process.env.PORT) || 8080;
server.listen(port, () => console.log(\`MCP server listening on \${port}\`));
`;

const MCP_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * What the platform's registry actually calls. If these pass, it can introspect this server and
 * offer its tools to an agent; if they fail, it records the server as unreachable with no tools.
 */
const call = async (method, params = {}) => {
  const res = await fetch(\`http://127.0.0.1:\${process.env.PORT || 8080}/mcp\`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { res, body: await res.json() };
};

test('initialize answers with a protocol version and a session', async () => {
  const { res, body } = await call('initialize', {});
  assert.equal(res.status, 200);
  assert.ok(body.result.protocolVersion, 'the client reads this');
  assert.ok(res.headers.get('mcp-session-id'), 'sent back on every later call');
});

test('tools/list is not empty', async () => {
  // A server with no tools is indistinguishable from a broken one to anything that lists it.
  const { body } = await call('tools/list');
  assert.ok(body.result.tools.length > 0);
  assert.ok(body.result.tools[0].inputSchema, 'a caller needs this to know how to call it');
});

test('tools/call returns text content', async () => {
  const { body } = await call('tools/call', { name: 'echo', arguments: { message: 'hi' } });
  assert.equal(body.result.content[0].type, 'text');
  assert.match(body.result.content[0].text, /hi/);
});

test('an unknown tool is an error, not a crash', async () => {
  const { res, body } = await call('tools/call', { name: 'nope', arguments: {} });
  assert.equal(res.status, 200, 'errors travel in the body, per JSON-RPC');
  assert.ok(body.error);
});
`;

/**
 * The starter file SETS, as data.
 *
 * ── WHY THE SWITCH ON TREE TYPE IS GONE ──
 * `templateFor(treeType)` keyed a `switch` on type strings, one of the three places that duplicated
 * what `TREE_TYPES` already declared. A project type is a record now and carries its own starter
 * files — so these are the CONTENTS those seeds point at, with `{{projectName}}` and
 * `{{registryHost}}` filled by `renderStarterFiles` rather than by a function call here.
 *
 * Exported so the seed file references them by name instead of holding several kilobytes of inline
 * source, which would make the seeds unreadable and their diffs useless.
 */
export const NODE_SERVICE_FILES = [
  { path: 'Dockerfile', content: NODE_DOCKERFILE('{{registryHost}}') },
  { path: 'package.json', content: NODE_PACKAGE('{{projectName}}') },
  { path: 'src/server.js', content: NODE_SERVER },
  { path: 'test/server.test.js', content: NODE_TEST },
  { path: 'README.md', content: README('{{projectName}}', 'service') },
];

export const MCP_SERVER_FILES = [
  { path: 'Dockerfile', content: NODE_DOCKERFILE('{{registryHost}}') },
  { path: 'package.json', content: NODE_PACKAGE('{{projectName}}') },
  { path: 'src/server.js', content: MCP_SERVER.replace('NAME_PLACEHOLDER', '{{projectName}}') },
  { path: 'test/server.test.js', content: MCP_TEST },
  { path: 'README.md', content: README('{{projectName}}', 'service') },
];

/**
 * No Dockerfile and no server: a library is not deployed, and giving it one would have the pipeline
 * build an image nobody wants.
 */
export const LIBRARY_FILES = [
  { path: 'package.json', content: NODE_PACKAGE('{{projectName}}') },
  { path: 'README.md', content: README('{{projectName}}', 'library') },
];
