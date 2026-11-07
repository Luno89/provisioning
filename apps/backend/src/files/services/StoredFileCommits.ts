import { randomUUID } from 'node:crypto';
import { startedFor, type Workflows } from '../../platform/index.js';
import { STORED_FILES_WORKFLOW, storedFilesWorkflowId, type StoredFilesDone, type StoredFilesWork } from '../lib/stored-files-work.js';
import type { StoredFileCommits } from './StoredFiles.js';

export function temporalStoredFileCommits(workflows: () => Promise<Pick<Workflows, 'start'>>, taskQueue: string): StoredFileCommits {
  const run = async (work: StoredFilesWork): Promise<StoredFilesDone> => {
    const handle = await (await workflows()).start(STORED_FILES_WORKFLOW, {
      workflowId: storedFilesWorkflowId(work.ownerId, randomUUID()),
      taskQueue,
      args: [work],
      ...startedFor(work.ownerId),
    });
    return handle.result() as Promise<StoredFilesDone>;
  };
  return {
    async commit(ownerId, commits, { replace }) {
      const done = await run({ op: 'commit', ownerId, commits: [...commits], replace });
      if (done.op !== 'commit') throw new Error(`a commit came back as ${done.op}`);
      return done.plan;
    },
    async remove(ownerId, ids) {
      await run({ op: 'remove', ownerId, ids: [...ids] });
    },
  };
}
