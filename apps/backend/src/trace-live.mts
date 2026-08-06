import { WorkspaceService } from './services/WorkspaceService.js';
import { runAgentLoop } from './lib/agent-loop.js';
import { imageForLanguage } from './lib/workspace-spec.js';

const ws = new WorkspaceService();
const leafId = 'trace-probe';
const task = [
  'Create /work/fib.js exporting a function fib(n) returning the nth Fibonacci number.',
  'Then create /work/test.js which requires it, checks fib(10) === 55, and prints "PASS" or throws.',
  'Run it with node and make sure it passes.',
].join('\n');

try {
  await ws.create({ leafId, ownerId: 'probe', image: imageForLanguage('node') }, 300_000);
  const r = await runAgentLoop({
    baseUrl: process.env.BASE!, kind: 'tabbyapi', language: 'node', taskContext: task,
    maxSteps: 6, think: false, captureTrace: true,
    sandbox: {
      exec: (c) => ws.exec(leafId, c),
      readFile: (p) => ws.readFile(leafId, p),
      writeFile: (p, c) => ws.writeFile(leafId, p, c),
    },
  });
  console.log(`ok=${r.succeeded} steps=${r.steps} tokens=${r.tokensUsed}\n`);
  for (const s of r.trace ?? []) {
    console.log(`-- step ${s.step} (${s.tokens}t) tools=[${s.toolCalls.map((c) => c.name).join(',')}]`);
    if (s.reasoning) console.log('   reasoning:', JSON.stringify(s.reasoning.slice(0, 200)));
    if (s.content) console.log('   said     :', JSON.stringify(s.content.slice(0, 320)));
    for (const c of s.toolCalls) console.log('   args     :', c.arguments.slice(0, 200));
  }
} finally { await ws.destroy(leafId); }
