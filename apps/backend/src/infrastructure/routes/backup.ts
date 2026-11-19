import { Router } from 'express';
import path from 'path';
import { ProcessNotStarted } from '@koala/engine-core/processes';
import { asyncRoute, nodeProcesses, type Processes } from '../../platform/index.js';

export interface BackupRouterDeps {
  repoRoot: string;
  processes?: Processes | undefined;
}

export function backupRouter(deps: BackupRouterDeps): Router {
  const router = Router();
  const processes = deps.processes ?? nodeProcesses;

  router.post('/run', asyncRoute(async (_req, res) => {
    const script = path.join(deps.repoRoot, 'scripts/backup-to-drive.sh');
    let output = '';
    const said = (chunk: string): void => { output += chunk; };
    try {
      const ran = await processes.run({ command: 'bash', args: [script], cwd: deps.repoRoot }, { stdout: said, stderr: said });
      res.json({ success: ran.code === 0, output });
    } catch (err) {
      if (!(err instanceof ProcessNotStarted)) throw err;
      res.status(500).json({ success: false, output: `${output}\n${err.reason}` });
    }
  }));

  return router;
}
