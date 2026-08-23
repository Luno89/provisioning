import { MongoDB } from '../lib/mongo-db.js';
import { v4 as uuidv4 } from 'uuid';
import type { Experiment } from '@koala/harness-types';

async function main() {
  const mongo = new MongoDB();
  await mongo.init();

  const now = new Date().toISOString();
  const ownerId = '2d5fe7e1-e7fc-4e88-8faf-8f08ba8b8991';

  // 1. Comprehensive Benchmark Experiment Suite
  const name1 = 'Advanced Engineering & Comprehensive Harness Benchmarks';
  const existing1 = (await mongo.getExperiments()).filter((e) => e.name === name1 || e.name === 'Advanced Engineering & Multi-File Architecture Benchmarks');
  for (const item of existing1) {
    await mongo.deleteExperiment(item.id);
  }

  const experiment1: Experiment = {
    id: existing1[0]?.id ?? uuidv4(),
    ownerId,
    name: name1,
    language: 'node',
    status: 'draft',
    // Empty rather than absent: `results` is required, and a run appends to it.
    results: [],
    repeats: 2,
    createdAt: now,
    updatedAt: now,
    variants: [
      {
        label: 'control-no-memories',
        overrides: { useMemories: false },
      },
      {
        label: 'memory-bank-enabled',
        overrides: { useMemories: true },
      },
      {
        label: 'finish-discipline',
        overrides: {
          extraInstructions: 'Call finish immediately after executing or verifying your work. Do not run diagnostic commands after the target file is created or fixed.',
        },
      },
      {
        label: 'max-steps-12',
        overrides: { maxSteps: 12 },
      },
      {
        label: 'top-p-0.1',
        overrides: { top_p: 0.1 },
      },
    ],
    tasks: [
      {
        id: 't1',
        name: 't1-calc-script',
        prompt: 'Create /work/calc.js that computes (47 * 3) + (15 / 5) and prints the integer result to stdout.',
        verifyCommand: 'node /work/calc.js | grep -q "^144$"',
      },
      {
        id: 't2',
        name: 't2-json-transform',
        prompt: 'Read /work/data.json, calculate the sum of all numbers in the "items" array, and write {"total": sum} to /work/summary.json.',
        verifyCommand: 'node -e \'const d=require("./summary.json"); if(d.total!==60) process.exit(1);\'' ,
        seed: [
          {
            path: 'data.json',
            content: '{\n  "items": [10, 20, 30]\n}',
          },
        ],
      },
      {
        id: 't3',
        name: 't3-fix-failing-test',
        prompt: 'Run node test.js, observe why it fails, fix the bug in /work/sum.js so sum(a,b) returns a + b, and verify the test passes.',
        verifyCommand: 'node /work/test.js',
        seed: [
          {
            path: 'sum.js',
            content: 'function sum(a, b) {\n  return a - b;\n}\nmodule.exports = { sum };\n',
          },
          {
            path: 'test.js',
            content: 'const { sum } = require("./sum.js");\nif (sum(2, 3) !== 5) {\n  console.error("Test failed: sum(2, 3) !== 5");\n  process.exit(1);\n}\nconsole.log("Test passed!");\n',
          },
        ],
      },
      {
        id: 't4',
        name: 't4-auth-middleware',
        prompt: 'Implement Express authentication middleware in /work/auth.js that validates Bearer JWT tokens from Authorization headers, attaches user payload to req.user, and returns 401 Unauthorized for missing/expired/invalid tokens.',
        verifyCommand: 'node /work/test.js',
        seed: [
          {
            path: 'auth.js',
            content: 'function authMiddleware(req, res, next) {\n  // TODO: Implement JWT Bearer token validation\n  next();\n}\nmodule.exports = { authMiddleware };\n',
          },
          {
            path: 'test.js',
            content: `const { authMiddleware } = require('./auth.js');
let failed = false;

function mockRes() {
  const res = { statusCode: 200, jsonBody: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (b) => { res.jsonBody = b; return res; };
  return res;
}

// Test 1: No header -> 401
const req1 = { headers: {} };
const res1 = mockRes();
let next1Called = false;
authMiddleware(req1, res1, () => { next1Called = true; });
if (res1.statusCode !== 401 || next1Called) {
  console.error('Test 1 Failed: Expected 401 on missing auth header');
  failed = true;
}

// Test 2: Invalid Bearer token format -> 401
const req2 = { headers: { authorization: 'Basic 12345' } };
const res2 = mockRes();
let next2Called = false;
authMiddleware(req2, res2, () => { next2Called = true; });
if (res2.statusCode !== 401 || next2Called) {
  console.error('Test 2 Failed: Expected 401 on invalid token scheme');
  failed = true;
}

if (failed) process.exit(1);
console.log('Auth middleware tests passed!');
`,
          },
        ],
      },
      {
        id: 't5',
        name: 't5-rest-api-crud',
        prompt: 'Build an in-memory REST API controller in /work/users.js with getAllUsers(), getUserById(id), createUser(data), and deleteUser(id). Ensure createUser validates that email is required.',
        verifyCommand: 'node /work/test.js',
        seed: [
          {
            path: 'users.js',
            content: 'class UserController {\n  // TODO: Implement CRUD\n}\nmodule.exports = { UserController };\n',
          },
          {
            path: 'test.js',
            content: `const { UserController } = require('./users.js');
const controller = new UserController();

let users = controller.getAllUsers();
if (!Array.isArray(users) || users.length !== 0) {
  console.error('Test Failed: Initial users should be empty array');
  process.exit(1);
}

try {
  controller.createUser({ name: 'Alice' });
  console.error('Test Failed: createUser should throw if email is missing');
  process.exit(1);
} catch (e) {
  // Expected validation error
}

const created = controller.createUser({ name: 'Alice', email: 'alice@example.com' });
if (!created || !created.id || created.email !== 'alice@example.com') {
  console.error('Test Failed: User creation payload invalid');
  process.exit(1);
}

console.log('User Controller CRUD tests passed!');
`,
          },
        ],
      },
      {
        id: 't6',
        name: 't6-async-queue-retry',
        prompt: 'Implement an Async Job Queue in /work/queue.js that processes tasks with a max concurrency cap of 2 and automatically retries failed tasks up to 3 times.',
        verifyCommand: 'node /work/test.js',
        seed: [
          {
            path: 'queue.js',
            content: 'class AsyncQueue {\n  constructor(concurrency = 2) {}\n  async push(fn) {}\n}\nmodule.exports = { AsyncQueue };\n',
          },
          {
            path: 'test.js',
            content: `const { AsyncQueue } = require('./queue.js');

async function run() {
  const queue = new AsyncQueue(2);
  let active = 0;
  let maxActive = 0;

  const makeTask = (shouldFailCount = 0) => {
    let attempts = 0;
    return async () => {
      active++;
      if (active > maxActive) maxActive = active;
      await new Promise(r => setTimeout(r, 10));
      attempts++;
      active--;
      if (attempts <= shouldFailCount) throw new Error('Transient error');
      return 'ok';
    };
  };

  const p1 = queue.push(makeTask(1));
  const p2 = queue.push(makeTask(0));
  const p3 = queue.push(makeTask(0));

  const results = await Promise.all([p1, p2, p3]);
  if (results.join(',') !== 'ok,ok,ok') {
    console.error('Queue results unexpected:', results);
    process.exit(1);
  }

  if (maxActive > 2) {
    console.error('Concurrency limit exceeded:', maxActive);
    process.exit(1);
  }

  console.log('Async Queue tests passed!');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
`,
          },
        ],
      },
    ],
  };

  await mongo.saveExperiment(experiment1);
  console.log(`Successfully created benchmark suite 1: "${experiment1.name}" (${experiment1.id}) with ${experiment1.tasks?.length ?? 0} tasks`);

  // 2. Dedicated Tool Repository & Memory Bank Coverage Suite
  const name2 = 'Tool Repository & Memory Bank Capabilities Suite';
  const existing2 = (await mongo.getExperiments()).filter((e) => e.name === name2);
  for (const item of existing2) {
    await mongo.deleteExperiment(item.id);
  }

  const experiment2: Experiment = {
    id: existing2[0]?.id ?? uuidv4(),
    ownerId,
    name: name2,
    language: 'node',
    status: 'draft',
    // Empty rather than absent: `results` is required, and a run appends to it.
    results: [],
    repeats: 2,
    createdAt: now,
    updatedAt: now,
    variants: [
      {
        label: 'control-no-memories',
        overrides: { useMemories: false },
      },
      {
        label: 'memory-bank-enabled',
        overrides: { useMemories: true },
      },
      {
        label: 'full-toolset-memory-active',
        overrides: { useMemories: true, maxSteps: 16 },
      },
    ],
    tasks: [
      {
        id: 'tool-git-inspect',
        name: 't-tool-git-diff',
        prompt: 'Call the inspect_git_diff tool to inspect git changes in /work. Write a summary object {"stagedCount": 0, "modifiedFiles": ["index.js"]} to /work/git-summary.json.',
        verifyCommand: 'node -e \'const d=require("./git-summary.json"); if(typeof d.stagedCount!=="number" || !Array.isArray(d.modifiedFiles)) process.exit(1);\'' ,
        seed: [
          {
            path: 'index.js',
            content: 'console.log("Original content");\n',
          },
        ],
      },
      {
        id: 'tool-http-test',
        name: 't-tool-http-endpoint',
        prompt: 'Call the test_http_endpoint tool to query endpoint http://localhost:8080/health. Write {"status": 200, "ok": true} to /work/http-result.json.',
        verifyCommand: 'node -e \'const d=require("./http-result.json"); if(!d.ok || d.status!==200) process.exit(1);\'' ,
      },
      {
        id: 'tool-linter-audit',
        name: 't-tool-linter-audit',
        prompt: 'Call the run_linter_audit tool to audit /work/src/app.js, fix the code formatting in app.js, and write "clean" to /work/linter-status.txt.',
        verifyCommand: 'grep -q "clean" /work/linter-status.txt && node /work/src/app.js',
        seed: [
          {
            path: 'src/app.js',
            content: 'function main() {\n  console.log("App initialized");\n}\nmain();\n',
          },
        ],
      },
      {
        id: 'tool-db-query',
        name: 't-tool-db-query',
        prompt: 'Call the query_in_memory_db tool to query /work/db.json, count active users, and write {"activeCount": 2} to /work/db-summary.json.',
        verifyCommand: 'node -e \'const d=require("./db-summary.json"); if(d.activeCount!==2) process.exit(1);\'' ,
        seed: [
          {
            path: 'db.json',
            content: '[\n  {"id": 1, "active": true},\n  {"id": 2, "active": false},\n  {"id": 3, "active": true}\n]',
          },
        ],
      },
      {
        id: 'tool-save-memory',
        name: 't-tool-save-memory',
        prompt: 'Call the save_harness_memory tool to record category "environment_facts", title "Node ESM extension rule", text "Node ESM require syntax requires extension" into the Memory Bank, and write "memory-saved" to /work/mem-status.txt.',
        verifyCommand: 'grep -q "memory-saved" /work/mem-status.txt',
      },
      {
        id: 'tool-unit-tests',
        name: 't-tool-unit-tests',
        prompt: 'Call the run_tests tool to execute tests with command "node test.js", fix the failing multiply implementation in /work/math.js so multiply(a,b) returns a * b, and call run_tests again to verify tests pass.',
        verifyCommand: 'node /work/test.js',
        seed: [
          {
            path: 'math.js',
            content: 'function multiply(a, b) {\n  return a + b;\n}\nmodule.exports = { multiply };\n',
          },
          {
            path: 'test.js',
            content: 'const { multiply } = require("./math.js");\nif (multiply(4, 3) !== 12) {\n  console.error("Test failed: multiply(4, 3) !== 12");\n  process.exit(1);\n}\nconsole.log("Tests passed!");\n',
          },
        ],
      },
    ],
  };

  await mongo.saveExperiment(experiment2);
  console.log(`Successfully created Tool Repository & Memory suite 2: "${experiment2.name}" (${experiment2.id}) with ${experiment2.tasks?.length ?? 0} tasks`);

  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to seed experiment:', err);
  process.exit(1);
});
