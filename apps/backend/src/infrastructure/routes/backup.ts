import { Router } from 'express';
import { startProcess, type StartProcess } from '../lib/shell.js';
import path from 'path';

export interface BackupRouterDeps {
  repoRoot: string;
  startScript?: StartProcess | undefined;
}

export function backupRouter(deps: BackupRouterDeps): Router {
  const router = Router();
  const startScript = deps.startScript ?? startProcess;

  router.post('/run', (_req, res) => {
    const script = path.join(deps.repoRoot, 'scripts/backup-to-drive.sh');
    const child = startScript('bash', [script], { cwd: deps.repoRoot });

    let output = '';
    child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { output += d.toString(); });

    child.on('close', (exitCode) => {
      res.json({ success: exitCode === 0, output });
    });
    child.on('error', (err) => {
      res.status(500).json({ success: false, output: `${output}\n${err.message}` });
    });
  });

  return router;
}
