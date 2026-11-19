import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeSteps, runSteps, StepFailed, type Step, type ServiceContext } from '@koala/provision';
import { memoryReporter } from '@koala/provision/testing';
import { mongoClientFor } from '../lib/collection.js';
import { mongoStep } from '../wiring/root-services.js';
import { madePrimary, testMongo } from './test-mongo.js';

const ctx: ServiceContext = {};
const started: Step<ServiceContext>[] = [];
const folders: string[] = [];
afterEach(async () => {
  await removeSteps(started.splice(0), ctx, memoryReporter());
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

async function folder(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), 'koala-memory-mongo-'));
  folders.push(made);
  return made;
}

function stepFor(dbPath: string) {
  const mongo = testMongo(dbPath);
  const step = mongoStep(mongo, () => mongo.address());
  started.push(step);
  return { mongo, step };
}

const failureOf = async (run: Promise<void>): Promise<StepFailed> => {
  const err: unknown = await run.then(() => undefined, (thrown: unknown) => thrown);
  if (!(err instanceof StepFailed)) throw new Error(`expected StepFailed, the run ended with ${String(err)}`);
  return err;
};

describe('the test Mongo, a mongod of this run started by the step root\'s Mongo is', () => {
  it('starts as a writable primary in its folder, and its removal stops it and takes the folder away', async () => {
    const dbPath = join(await folder(), 'mongo');
    const { mongo, step } = stepFor(dbPath);
    await runSteps([step], ctx, memoryReporter());
    await madePrimary(mongo);
    const client = mongoClientFor(mongo.uri());
    await client.db('koala').collection('probe').insertOne({ written: true });
    await client.close();
    expect(existsSync(dbPath)).toBe(true);
    await removeSteps([step], ctx, memoryReporter());
    expect(existsSync(dbPath)).toBe(false);
  });

  it('fails at once when mongod cannot start, saying why and how much room the disk it writes to has', async () => {
    const dbPath = join(await folder(), 'read-only');
    await mkdir(dbPath);
    await chmod(dbPath, 0o500);
    const failure = await failureOf(runSteps([stepFor(dbPath).step], ctx, memoryReporter()));
    expect(failure.stepId).toBe('mongo');
    expect(failure.why).toMatch(new RegExp(`^Mongo, as a replica set to answer: the test Mongo could not start: mongod exited with \\d+ .+ \\(disk where it writes: ${dbPath}, [0-9.]+ [KMGT]?B free\\)( \\(.+\\))?$`, 's'));
  });

  it('says when mongod ends while the run still needs it, with why and the room left', async () => {
    const dbPath = join(await folder(), 'mongo');
    const { mongo, step } = stepFor(dbPath);
    await runSteps([step], ctx, memoryReporter());
    const ended = new Promise<string>((done) => { mongo.onEnded(done); });
    process.kill(mongo.pid(), 'SIGKILL');
    expect(await ended).toMatch(new RegExp(`^the test Mongo ended while the run needed it: mongod was killed by SIGKILL .*\\(disk where it writes: ${dbPath}, [0-9.]+ [KMGT]?B free\\)$`, 's'));
  });
});
