import type { ReadDeletingMarks } from '@koala/engine-core/work-for';
import type { Database } from '../lib/db-interface.js';

export interface DeletingMarkRecords {
  projects: Pick<Database['projects'], 'deletion'>;
  accounts: Pick<Database['accounts'], 'getUserById'>;
}

export const deletingMarksIn = (records: DeletingMarkRecords): ReadDeletingMarks => async (work) => {
  const [owner, project] = await Promise.all([
    work.owner ? records.accounts.getUserById(work.owner).then((user) => user?.removal !== undefined) : false,
    work.project ? records.projects.deletion(work.project).then((mark) => mark !== undefined) : false,
  ]);
  return { owner, project };
};
