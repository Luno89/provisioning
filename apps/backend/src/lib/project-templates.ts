import { ODOO_CHART_FILES } from './odoo-chart-template.js';

export interface TemplateFile {
  path: string;
  content: string;
}

export const MIRROR_NAMESPACE = 'provisioning-bot';

export function nodeBaseImage(registryHost?: string): string {
  return registryHost ? `${registryHost}/${MIRROR_NAMESPACE}/node:22-alpine` : 'node:22-alpine';
}

const NODE_DOCKERFILE = (base: string) => [
  '# This Dockerfile already works. Change it only if you add dependencies or build steps.',
  '#',
  '# It is deliberately single-stage. A multi-stage build that copies node_modules out of an',
  '# install stage FAILS on a project with no dependencies — npm installs nothing, the directory',
  '# never exists, and the error names a path inside the builder rather than the cause.',
  '# Measured: three separate build failures from one rewrite of this file.',
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

export const LIBRARY_FILES = [
  { path: 'package.json', content: NODE_PACKAGE('{{projectName}}') },
  { path: 'README.md', content: README('{{projectName}}', 'library') },
];

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

const ODOO_DOCKERFILE = `FROM odoo:18
USER root
COPY ./addons /mnt/extra-addons
RUN chown -R odoo:odoo /mnt/extra-addons
USER odoo
`;

const ODOO_README = (name: string) => `# ${name}

Odoo 18 Community addons, built into an image \`FROM odoo:18\` with \`addons/\` copied to \`/mnt/extra-addons\`.

- Every feature is a module, or a change to one, under \`addons/\` — see \`addons/README.md\`.
- How a change is checked: \`CHECKS.md\`.
- A push to \`main\` builds the image.
`;

const ODOO_ADDONS_README = `# Addons

One folder per module. A module's folder name is its technical name: lower case, words joined by underscores.

\`\`\`
addons/sale_delivery_note/
  __init__.py                 from . import models
  __manifest__.py             name, version '18.0.1.0.0', depends, data, license 'LGPL-3'
  models/__init__.py          from . import sale_order
  models/sale_order.py        class SaleOrder(models.Model): _inherit = 'sale.order'; a new field
  views/sale_order_views.xml  inherits the form view to show the field
  security/ir.model.access.csv  access rules for any new model
  tests/__init__.py           from . import test_sale_order
  tests/test_sale_order.py    TransactionCase tests of what the module adds
\`\`\`

- Extend existing models with \`_inherit\`; never edit Odoo's own modules.
- Every file listed under \`data\` in the manifest has to exist, and every new model needs an access rule.
- Every module has tests in \`tests/\` for what it adds; \`odoo-check\` runs only the modules you name.
`;

const ODOO_CHECKS = `# How work on this project is checked

Run from the repository root:

\`\`\`
odoo-check <module>[,<module>] addons
\`\`\`

It installs the named modules into a fresh, throwaway Odoo 18 database, runs their tests, and ends with
\`odoo-check: PASSED\` or \`odoo-check: FAILED\`. Name every module the work added or changed, and the modules that
depend on them.

Changes a person would see — a field, a view, a menu, a button — come with a browser test in \`e2e/\`
(TypeScript Playwright; \`e2e/signs-in.spec.ts\` shows the shape). Run it with:

\`\`\`
odoo-e2e <module>[,<module>] e2e
\`\`\`

It installs the modules into a throwaway Odoo it serves on localhost, signs in there as \`ODOO_LOGIN\` /
\`ODOO_PASSWORD\` (that throwaway database's own admin, never a real one), runs the specs in Chromium, and ends with
\`odoo-e2e: PASSED\` or \`odoo-e2e: FAILED\`. Screenshots, traces and videos of failures land in \`e2e-results/\`.

A task whose work a person would see carries the browser tests as its check, so each test is reported on its own and
a failure keeps what the browser saw:

\`\`\`
"checks": { "e2e": { "specs": ["e2e/<the spec>.spec.ts"] } }
\`\`\`

That serves every module under \`addons/\` the same way (\`koala-e2e <specs>\`).

Changes under \`deploy/chart/\` (the Helm chart this project deploys with) are checked with:

\`\`\`
helm lint deploy/chart && helm template check deploy/chart --set image.repository=check --set slots.a.tag=x --set host=check.local > /dev/null
\`\`\`

The chart keeps two slots, a and b, on one PostgreSQL; the platform decides which is live and which tag each runs, so
leave \`live\`, \`slots\`, \`image\`, \`host\` and \`previewHost\` to it.

A piece of work is done when:
- \`odoo-check\` says PASSED for every module it touched, and \`odoo-e2e\` for its browser tests when it has any;
- each module's tests cover what the work added (a new field is set and read back, a new rule is enforced);
- the manifest lists every data file, and every new model has an access rule.

A judge runs the same command against the claimed commit and reads the tests, not only the result.
`;

export const ODOO_PLAYWRIGHT_CONFIG = `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'e2e-results/artifacts',
  timeout: 60_000,
  use: {
    baseURL: process.env.BASE_URL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
});
`;

export const ODOO_E2E_EXAMPLE = `import { test, expect } from '@playwright/test';

test('a person signs in and reaches the Odoo home', async ({ page }) => {
  await page.goto('/web/login');
  await page.fill('input[name="login"]', process.env.ODOO_LOGIN!);
  await page.fill('input[name="password"]', process.env.ODOO_PASSWORD!);
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/\\/odoo/);
  await expect(page.locator('.o_main_navbar')).toBeVisible();
});
`;

export const ODOO_ADDONS_FILES = [
  { path: 'Dockerfile', content: ODOO_DOCKERFILE },
  { path: 'README.md', content: ODOO_README('{{projectName}}') },
  { path: 'addons/README.md', content: ODOO_ADDONS_README },
  { path: 'CHECKS.md', content: ODOO_CHECKS },
  { path: '.gitignore', content: '__pycache__/\n*.pyc\ne2e-results/\n' },
  { path: 'playwright.config.ts', content: ODOO_PLAYWRIGHT_CONFIG },
  { path: 'e2e/signs-in.spec.ts', content: ODOO_E2E_EXAMPLE },
  ...ODOO_CHART_FILES,
];
