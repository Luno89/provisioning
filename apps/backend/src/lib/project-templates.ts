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

import type { ValidationRecipe } from './tree-types.js';

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

/** UI application template: Vite + React 19 single-page application. */
export const UI_APP_FILES = [
  {
    path: 'package.json',
    content: JSON.stringify({
      name: '{{projectName}}',
      private: true,
      version: '0.1.0',
      type: 'module',
      scripts: {
        dev: 'vite',
        build: 'vite build',
        preview: 'vite preview',
      },
      dependencies: {
        react: '^19.0.0',
        'react-dom': '^19.0.0',
      },
      devDependencies: {
        '@vitejs/plugin-react': '^4.3.4',
        typescript: '^5.7.2',
        vite: '^6.0.7',
      },
    }, null, 2),
  },
  {
    path: 'vite.config.ts',
    content: `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3000,
  },
  preview: {
    host: '0.0.0.0',
    port: 8080,
  },
});
`,
  },
  {
    path: 'index.html',
    content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{{projectName}}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
  },
  {
    path: 'src/main.tsx',
    content: `import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
`,
  },
  {
    path: 'src/App.tsx',
    content: `import React, { useState } from 'react';

export function App() {
  const [count, setCount] = useState(0);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: '800px', margin: '0 auto' }}>
      <h1>{{projectName}}</h1>
      <p>Frontend user interface application.</p>
      <button
        type="button"
        onClick={() => setCount((c) => c + 1)}
        style={{ padding: '0.5rem 1rem', fontSize: '1rem', cursor: 'pointer' }}
      >
        Count: {count}
      </button>
    </main>
  );
}
`,
  },
  {
    path: 'src/index.css',
    content: `body {
  margin: 0;
  background-color: #0f172a;
  color: #f8fafc;
}
`,
  },
  {
    path: 'Dockerfile',
    content: `FROM {{registryHost}}/provisioning-bot/node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
`,
  },
  {
    path: 'README.md',
    content: `# {{projectName}}\n\nInteractive Vite + React user interface application.\n`,
  },
];

/** Structured research paper template. */
export const RESEARCH_PAPER_FILES = [
  {
    path: 'paper.md',
    content: `# {{projectName}}

## Abstract
Brief overview summarizing the background, methodology, experimental findings, and conclusions.

## Introduction
Problem statement, operational context, and core research objectives.

## Methodology
Investigation tooling, experimental setup, datasets, and execution environment.

## Analysis & Findings
Detailed experimental results, verified empirical data, comparative metrics, and trade-offs.

## Limitations & Non-Goals
Operational bounds and constraints of this work.

## Conclusion
Key takeaways and recommended future directions.

## References
Cited academic publications, repositories, cluster documentation, and benchmark traces.
`,
  },
  {
    path: 'metadata.json',
    content: JSON.stringify({
      title: '{{projectName}}',
      kind: 'research-paper',
      status: 'draft',
      citations: [],
    }, null, 2),
  },
  {
    path: 'README.md',
    content: `# {{projectName}}\n\nResearch paper and technical synthesis document.\n`,
  },
];

/** Decision brief template. */
export const DECISION_BRIEF_FILES = [
  {
    path: 'brief.md',
    content: `# Decision Brief: {{projectName}}

## Context & Problem Statement
The operational problem or technical architecture change requiring an explicit decision.

## Decision Drivers & Constraints
Evaluation criteria, non-functional requirements, latency/budget bounds, and prerequisites.

## Options Considered
Detailed breakdown of candidate approaches evaluated.

## Tradeoff Matrix
Multi-variable comparative analysis (see matrix.csv for scored criteria).

## Recommendation
Unambiguous recommendation backed by empirical evidence and comparative analysis.

## Implementation Plan & Risks
Execution milestones, backward compatibility guarantees, and fallback procedures.
`,
  },
  {
    path: 'matrix.csv',
    content: `Option,Feasibility,Impact,Cost,Risk,Confidence,Recommendation
Option A (Recommended),High,High,Low,Low,High,Selected
Option B,Medium,Medium,Medium,Medium,Medium,Alternative
`,
  },
  {
    path: 'README.md',
    content: `# Decision Brief: {{projectName}}\n\nEvaluates architectural options and documents rationale.\n`,
  },
];

/** Structured dataset template. */
export const DATASET_FILES = [
  {
    path: 'schema.json',
    content: JSON.stringify({
      $schema: 'http://json-schema.org/draft-07/schema#',
      title: '{{projectName}}Record',
      type: 'object',
      properties: {
        id: { type: 'string' },
        timestamp: { type: 'string' },
        source: { type: 'string' },
        data: { type: 'object' },
      },
      required: ['id', 'timestamp', 'source', 'data'],
    }, null, 2),
  },
  {
    path: 'dataset.jsonl',
    content: `{"id":"sample-001","timestamp":"2026-01-01T00:00:00Z","source":"bootstrap","data":{"verified":true}}\n`,
  },
  {
    path: 'README.md',
    content: `# {{projectName}} Dataset\n\nCurated and validated data records with schema provenance.\n`,
  },
];

/** Performance benchmark template. */
export const BENCHMARK_FILES = [
  {
    path: 'benchmark.js',
    content: `import { performance } from 'node:perf_hooks';

console.log('Running benchmark suite for {{projectName}}...');
const start = performance.now();
// Simulated workload
let accum = 0;
for (let i = 0; i < 100_000; i++) {
  accum += Math.sqrt(i);
}
const elapsed = performance.now() - start;
console.log(\`Benchmark completed in \${elapsed.toFixed(2)}ms (checksum: \${accum.toFixed(0)})\`);
`,
  },
  {
    path: 'package.json',
    content: JSON.stringify({
      name: '{{projectName}}',
      version: '1.0.0',
      type: 'module',
      scripts: {
        test: 'node benchmark.js',
        bench: 'node benchmark.js',
      },
    }, null, 2),
  },
  {
    path: 'README.md',
    content: `# Benchmark: {{projectName}}\n\nReproducible performance benchmarks and metrics suite.\n`,
  },
];

/** Investigation / incident analysis template. */
export const INVESTIGATION_FILES = [
  {
    path: 'report.md',
    content: `# Root Cause Investigation: {{projectName}}

## Executive Summary
Concise statement of the observed failure, performance regression, or unexpected behavior.

## Timeline of Events
Chronological sequence of logs, alerts, and state mutations.

## Symptoms & Diagnostic Evidence
Full log extracts, network captures, stack traces, and pod failure statuses.

## Root Cause Analysis
Technical explanation of the defect mechanism and five-whys analysis.

## Remediation & Preventative Action
Immediate fix applied and systemic guardrails established to prevent recurrence.
`,
  },
  {
    path: 'reproduction.sh',
    content: `#!/usr/bin/env bash
set -euo pipefail
echo "Reproducing failure case for {{projectName}}..."
`,
  },
  {
    path: 'README.md',
    content: `# Investigation: {{projectName}}\n\nRoot cause analysis and diagnostic evidence.\n`,
  },
];

/* ── Validation Recipes ────────────────────────────────────────── */

export const MCP_SERVER_RECIPE: ValidationRecipe = {
  type: 'runtime-service',
  checks: [
    { id: 'pkg-json', name: 'package.json exists', type: 'file-exists', target: 'package.json' },
    { id: 'src-server', name: 'Server entrypoint exists', type: 'file-exists', target: 'src/server.js' },
    { id: 'dockerfile', name: 'Dockerfile exists', type: 'file-exists', target: 'Dockerfile' },
    { id: 'unit-tests', name: 'Unit tests pass', type: 'run-command', command: 'npm test' },
    { id: 'mcp-probe', name: 'MCP initialize probe', type: 'mcp-probe', target: 'http://127.0.0.1:8080/mcp' },
  ],
};

export const NODE_SERVICE_RECIPE: ValidationRecipe = {
  type: 'runtime-service',
  checks: [
    { id: 'pkg-json', name: 'package.json exists', type: 'file-exists', target: 'package.json' },
    { id: 'src-server', name: 'Server entrypoint exists', type: 'file-exists', target: 'src/server.js' },
    { id: 'unit-tests', name: 'Unit tests pass', type: 'run-command', command: 'npm test' },
    { id: 'health-probe', name: 'Health check responds 200', type: 'http-probe', target: 'http://127.0.0.1:8080/health', expectedStatus: 200 },
  ],
};

export const UI_APP_RECIPE: ValidationRecipe = {
  type: 'command',
  checks: [
    { id: 'pkg-json', name: 'package.json exists', type: 'file-exists', target: 'package.json' },
    { id: 'index-html', name: 'index.html exists', type: 'file-exists', target: 'index.html' },
    { id: 'src-app', name: 'App root component exists', type: 'file-exists', target: 'src/App.tsx' },
    { id: 'build', name: 'Frontend builds successfully', type: 'run-command', command: 'npm run build' },
    { id: 'dist-html', name: 'dist/index.html generated', type: 'file-exists', target: 'dist/index.html' },
  ],
};

export const RESEARCH_PAPER_RECIPE: ValidationRecipe = {
  type: 'document',
  checks: [
    { id: 'paper-exists', name: 'paper.md exists', type: 'file-exists', target: 'paper.md' },
    { id: 'abstract', name: 'Contains Abstract', type: 'content-matches', target: 'paper.md', pattern: '## Abstract' },
    { id: 'findings', name: 'Contains Findings', type: 'content-matches', target: 'paper.md', pattern: '## Analysis & Findings' },
    { id: 'references', name: 'Contains References', type: 'content-matches', target: 'paper.md', pattern: '## References' },
  ],
};

export const DECISION_BRIEF_RECIPE: ValidationRecipe = {
  type: 'document',
  checks: [
    { id: 'brief-exists', name: 'brief.md exists', type: 'file-exists', target: 'brief.md' },
    { id: 'matrix-exists', name: 'matrix.csv exists', type: 'file-exists', target: 'matrix.csv' },
    { id: 'recommendation', name: 'Contains Recommendation', type: 'content-matches', target: 'brief.md', pattern: '## Recommendation' },
  ],
};

export const DATASET_RECIPE: ValidationRecipe = {
  type: 'document',
  checks: [
    { id: 'schema-exists', name: 'schema.json exists', type: 'file-exists', target: 'schema.json' },
    { id: 'dataset-exists', name: 'dataset.jsonl exists', type: 'file-exists', target: 'dataset.jsonl' },
  ],
};

export const LIBRARY_RECIPE: ValidationRecipe = {
  type: 'command',
  checks: [
    { id: 'pkg-json', name: 'package.json exists', type: 'file-exists', target: 'package.json' },
  ],
};

export const BENCHMARK_RECIPE: ValidationRecipe = {
  type: 'command',
  checks: [
    { id: 'bench-exists', name: 'benchmark.js exists', type: 'file-exists', target: 'benchmark.js' },
    { id: 'bench-run', name: 'Benchmark runs to completion', type: 'run-command', command: 'node benchmark.js' },
  ],
};

export const INVESTIGATION_RECIPE: ValidationRecipe = {
  type: 'document',
  checks: [
    { id: 'report-exists', name: 'report.md exists', type: 'file-exists', target: 'report.md' },
    { id: 'root-cause', name: 'Root cause section present', type: 'content-matches', target: 'report.md', pattern: '## Root Cause Analysis' },
  ],
};

export const MIGRATION_RECIPE: ValidationRecipe = {
  type: 'command',
  checks: [
    { id: 'unit-tests', name: 'Existing test suite passes', type: 'run-command', command: 'npm test' },
  ],
};


