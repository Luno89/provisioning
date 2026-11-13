import { randomUUID } from 'node:crypto';
import { startedFor, type Workflows } from '../../platform/index.js';
import { STORED_FILES_WORKFLOW, storedFilesWorkflowId, type StoredFilesDone, type StoredFilesWork } from '../lib/stored-files-work.js';
import type { StoredFileCommits } from './StoredFiles.js';
import type { StoredScope } from '../lib/stored-files.js';
import { withWorkFor } from '@koala/engine-core/work-for';

export function temporalStoredFileCommits(workflows: () => Promise<Pick<Workflows, 'start'>>, taskQueue: string): StoredFileCommits {
  const run = async (work: StoredFilesWork, scope: StoredScope | undefined): Promise<StoredFilesDone> => {
    const started = await withWorkFor({ project: scope?.kind === 'project' ? scope.id : undefined }, async () => (await workflows()).start(STORED_FILES_WORKFLOW, {
      workflowId: storedFilesWorkflowId(work.ownerId, randomUUID()),
      taskQueue,
      args: [work],
      ...startedFor(work.ownerId),
    }));
    return started.result() as Promise<StoredFilesDone>;
  };
  return {
    async commit(ownerId, commits, { replace, scope }) {
      const done = await run({ op: 'commit', ownerId, commits: [...commits], replace }, scope);
      if (done.op !== 'commit') throw new Error(`a commit came back as ${done.op}`);
      return done.plan;
    },
    async remove(ownerId, files, scope) {
      await run({ op: 'remove', ownerId, ids: files.map((file) => file.id), objectIds: files.map((file) => file.objectId) }, scope);
    },
  };
}
