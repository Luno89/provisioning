import { MongoDB } from '../lib/mongo-db.js';
import { v4 as uuidv4 } from 'uuid';
import type { Experiment } from '@koala/harness-types';

async function main() {
  const mongo = new MongoDB();
  await mongo.init();

  const existing = (await mongo.getExperiments()).filter(e => e.name === 'Harness Reliability & Tool Enforcement');
  for (const item of existing) {
    await mongo.deleteExperiment(item.id);
  }

  const now = new Date().toISOString();
  const experiment: Experiment = {
    id: existing[0]?.id ?? uuidv4(),
    ownerId: '2d5fe7e1-e7fc-4e88-8faf-8f08ba8b8991',
    name: 'Harness Reliability & Tool Enforcement',
    language: 'js',
    status: 'draft',
    repeats: 2,
    createdAt: now,
    updatedAt: now,
    variants: [
      {
        label: 'control-shipped',
        overrides: { temperature: 0.2 },
      },
      {
        label: 'think-enabled',
        overrides: { think: true, max_tokens: 2048 },
      },
      {
        label: 'strict-tool-prompt',
        overrides: {
          systemPrompt: 'You are an autonomous engineering assistant. YOU MUST CALL A TOOL ON EVERY TURN to take action (e.g. read_file, write_file, run_command). Always format tool arguments cleanly in standard JSON. For write_file, pass path (e.g. "summary.json") and content as a plain text string.',
        },
      },
      {
        label: 'temperature-0.0',
        overrides: { temperature: 0.0 },
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
    ],
  };

  await mongo.saveExperiment(experiment);
  console.log(`Successfully created experiment suite: "${experiment.name}" (${experiment.id})`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to seed experiment:', err);
  process.exit(1);
});
