import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { BUILT_IN_GROUPS, defineGroup, defineProcedure, readProcedure, type Procedure } from '@koala/agent-engine/procedure';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import { liveEngineHost } from './lib/live-engine-host.js';
import { getTemporalClient } from '../apps/backend/src/lib/temporal-client.js';
import { startedFor } from '../apps/backend/src/lib/workflow-owner.js';
import { extensionServiceFor } from '../apps/backend/src/services/ExtensionService.js';
import { createProcedureStore } from '../apps/backend/src/engine-host/registries/procedure-store.js';
import { DEFAULT_ENGINE_TASK_QUEUE, type AgentRunOutcome, type ProcedureRunInput } from '../apps/backend/src/engine-host/temporal/contracts.js';

dotenv.config({ path: new URL('../apps/backend/.env', import.meta.url).pathname });

const OWNER = process.env.EXTENSIONS_LIVE_OWNER ?? process.env.GROVE_LIVE_OWNER;
const AGENT = process.env.EXTENSIONS_LIVE_AGENT ?? 'executor';
const DEADLINE_MS = Number(process.env.EXTENSIONS_LIVE_MINUTES ?? '10') * 60_000;
const queue = process.env.TEMPORAL_ENGINE_TASK_QUEUE || DEFAULT_ENGINE_TASK_QUEUE;

const shout = (suffix: string) => defineGroup('shout', {
  title: 'Shout',
  describe: 'Says the text louder, in the run\'s own sandbox.',
  inputs: {
    text: { type: 'text', describe: 'What to say.', required: true },
    environment: { type: 'environment', describe: 'Where the code runs.', required: true },
  },
  outputs: { loud: { type: 'any', describe: 'The text, louder.' } },
  exits: { done: { describe: 'It was said.' }, empty: { describe: 'There was nothing to say.' } },
}, (g) => {
  const upper = g.code('upper', { text: g.inputs.text, environment: g.inputs.environment }, {
    body: `return { loud: String(inputs.text).toUpperCase() + ${JSON.stringify(suffix)} }`,
    inputs: [{ name: 'text', type: 'text' }],
    outputs: [{ name: 'loud', type: 'any' }],
  });
  const said = g.condition('said', { value: upper.loud! }, { expression: 'not empty(value)' });
  g.start(said);
  said.on('true', g.exits.done);
  said.on('false', g.exits.empty);
  g.output('loud', upper.loud!);
  g.layout({ upper: [0, 0], said: [260, 0] });
});

function greeter(id: string, extension: string, published: readonly Parameters<typeof defineProcedure>[0][number][]): Procedure {
  return defineProcedure([...BUILT_IN_GROUPS, ...published], { id, version: '1', name: 'Extensions live', describe: 'uses a published operation', budget: {} }, (p) => {
    const provision = p.provisionSandbox('provision');
    const hello = p.text('hello', {}, { text: 'hello from an extension' });
    const said = p.groups[`${extension}.shout@1`]!('shout', { text: hello.text, environment: provision.environment });
    const done = p.finish('done', { result: said.loud! }, { outcome: 'ok' });
    const silent = p.finish('silent', {}, { outcome: 'failed', reason: 'nothing was said' });
    const unavailable = p.finish('unavailable', { reason: provision.reason }, { outcome: 'failed' });
    const release = p.releaseSandbox('release', { environment: provision.environment });
    const cleaned = p.finish('cleaned', {}, { outcome: 'ok' });
    p.start(provision);
    p.cleanup(release);
    release.on('done', cleaned);
    provision.on('ready', said);
    provision.on('unavailable', unavailable);
    said.on('done', done);
    said.on('empty', silent);
    p.layout({ provision: [0, 0], hello: [0, 160], shout: [260, 0], done: [520, 0], silent: [520, 160], unavailable: [260, 160], release: [0, 320], cleaned: [260, 320] });
  });
}

async function main(): Promise<void> {
  assert.ok(OWNER, 'set EXTENSIONS_LIVE_OWNER (or GROVE_LIVE_OWNER) to the user to run as');
  const db = createDatabase();
  await db.init();
  const extensions = extensionServiceFor(db);
  const host = liveEngineHost(db);
  const client = await getTemporalClient();
  const stamp = Date.now().toString(36);
  const extension = `live-${stamp}`;
  const procedureId = `extensions-live-${stamp}`;

  try {
    console.log(`[1/5] ${extension} is made and Shout is published into it`);
    const made = await extensions.create(OWNER, { id: extension, title: `Live ${stamp}` });
    assert.ok(made.ok, made.ok ? '' : made.error);
    const first = await extensions.publish(OWNER, extension, 'shout', shout('!'));
    assert.ok(first.ok && first.value.id === `${extension}.shout@1`, first.ok ? first.value.id : first.error);

    console.log(`[2/5] ${procedureId} uses ${extension}.shout@1`);
    await db.saveProcedure({ id: procedureId, ownerId: OWNER, version: '1', source: JSON.stringify(greeter(procedureId, extension, await extensions.groups(OWNER))), updatedAt: new Date().toISOString() });
    if (!await host.registry.procedure(OWNER, procedureId)) {
      const store = createProcedureStore({ sources: { list: (ownerId?: string) => db.getProcedures(ownerId) }, published: (ownerId) => extensions.groups(ownerId) });
      const why = (await store.problems(OWNER)).find((problem) => problem.id === procedureId)?.report;
      assert.fail(`the stored procedure did not read back with the published group known: ${why ?? 'no reason given'}`);
    }

    console.log('[3/5] a second version is published, and the procedure moves onto it');
    const second = await extensions.publish(OWNER, extension, 'shout', shout('!!'));
    assert.ok(second.ok, second.ok ? '' : second.error);
    assert.deepEqual(second.value.moved, [procedureId]);
    const stored = readProcedure((await db.getProcedure(OWNER, procedureId))!.source);
    assert.ok(stored.ok);
    assert.equal(stored.procedure.nodes.find((node) => node.id === 'shout')?.group, `${extension}.shout@2`);

    const runnable = await host.registry.runnable(OWNER, AGENT, procedureId);
    assert.ok(runnable, 'the procedure could not be resolved to run');
    assert.deepEqual(runnable.procedure.groups.map((group) => group.id), [`${extension}.shout@2`], 'the run was not handed the published group');

    const runId = `extensions-live-${stamp}`;
    console.log(`[4/5] it runs on the engine worker (${runId})`);
    const input: ProcedureRunInput = {
      ticket: { runId, depth: 0, ownerId: OWNER, agentSlug: AGENT, trigger: 'user' },
      procedure: runnable.procedure,
      inputs: { message: 'shout' },
    };
    const handle = await client.workflow.start('AgentRunWorkflow', { workflowId: runId, taskQueue: queue, args: [input], ...startedFor(OWNER) });
    const result = await Promise.race([
      handle.result() as Promise<AgentRunOutcome>,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`still running after ${DEADLINE_MS / 60_000} minutes`)), DEADLINE_MS)),
    ]);
    const traces = await db.getRunTraces(OWNER, runId);
    console.log(`      ended ${result.outcome}${result.reason ? `: ${result.reason}` : ''} — ${JSON.stringify(result.outputs)}`);
    console.log(`      ${traces.length} traces: ${traces.map((trace) => `${trace.node}(${trace.kind})`).join(' → ')}`);

    assert.equal(result.outcome, 'ok', 'the run did not end ok');
    assert.equal((result.outputs as { result?: unknown }).result, 'HELLO FROM AN EXTENSION!!', 'the second version\'s code did not produce the answer');
    const code = traces.find((trace) => trace.kind === 'code');
    assert.ok(code, 'the code node inside the published group was not traced');
    assert.equal(code.node, 'shout.upper', 'the code node was not traced inside the published group');
    assert.equal(code.origin, 'shout');

    console.log('[5/5] switched off, the procedure is refused before it can start');
    await extensions.setEnabled(OWNER, extension, false);
    await assert.rejects(host.registry.runnable(OWNER, AGENT, procedureId), /switched off/);
    console.log('passed');
  } finally {
    await db.deleteProcedure(OWNER, procedureId);
    await extensions.setEnabled(OWNER, extension, true);
    const removed = await extensions.remove(OWNER, extension);
    if (!removed.ok) console.warn(`could not remove ${extension}: ${removed.error}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
