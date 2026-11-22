import { Context } from '@temporalio/activity';
import { NativeConnection } from '@temporalio/worker';
import type { BlobReach, Keyring } from '@koala/engine-core/payloads';
import { createWorker } from '@koala/engine-core/temporal';
import { MACHINE_STEP_ASKED_TO_STOP, MACHINE_STEP_STARTED } from './machine-step.fixture-workflow.js';

export interface MachineWorkerAt {
  address: string;
  namespace: string;
  taskQueue: string;
  ring: Keyring;
}

const kept = new Map<string, Uint8Array>();
const blobs: BlobReach = {
  async put(stored) { for (const blob of stored) kept.set(blob.id, blob.data); },
  async get(ids) { return new Map(ids.filter((id) => kept.has(id)).map((id) => [id, kept.get(id)!])); },
};

async function main(at: MachineWorkerAt): Promise<void> {
  const connection = await NativeConnection.connect({ address: at.address });
  const worker = await createWorker({
    connection,
    namespace: at.namespace,
    taskQueue: at.taskQueue,
    payloads: { ring: at.ring, blobs },
    deletingMarks: { unread: 'this machine reads no deletion marks: its work for a project being deleted is stopped by cancelling it' },
    activities: {
      MachineStepActivity: async () => {
        const stop = Context.current().cancellationSignal;
        process.stdout.write(`${MACHINE_STEP_STARTED}\n`);
        stop.addEventListener('abort', () => { process.stdout.write(`${MACHINE_STEP_ASKED_TO_STOP}\n`); }, { once: true });
        return new Promise<string>(() => undefined);
      },
    },
  });
  await worker.run();
}

const [, , given] = process.argv;
if (given) await main(JSON.parse(given) as MachineWorkerAt);
