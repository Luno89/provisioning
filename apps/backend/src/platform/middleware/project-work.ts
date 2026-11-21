import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { WorkStopped, withWorkFor } from '@koala/engine-core/work-for';
import type { Database } from '../lib/db-interface.js';

export type ProjectOf = (req: Request) => Promise<string | undefined>;

export interface DeletingRequests {
  letThrough?: readonly string[] | undefined;
  whileArchived?: readonly string[] | undefined;
  gone?: true | undefined;
}

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function projectWork(projects: Pick<Database['projects'], 'deletion'>, projectOf: ProjectOf, how: DeletingRequests = {}): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const project = await projectOf(req);
      if (!project) return next();
      const asked = `${req.method} ${req.path}`;
      const mark = READS.has(req.method) ? undefined : await projects.deletion(project);
      const allowed = mark?.phase === 'archived' ? how.whileArchived : how.letThrough;
      if (mark && !allowed?.includes(asked)) {
        return res.status(how.gone ? 410 : 409).json({ error: new WorkStopped({ kind: 'project', id: project }).message });
      }
      return withWorkFor({ project }, () => next());
    })().catch(next);
  };
}
