import { Router } from 'express';
import { spawn } from 'child_process';
import path from 'path';

/**
 * Running a backup to the configured Google Drive.
 *
 * ── WHY THIS IS ITS OWN FILE FOR ONE ROUTE ──
 * It is the button on the Google Drive card in `CloudAccounts`, so it moved in the same slice as
 * the credentials routes. It is not a credentials operation though, and `/api/backup` is its own
 * prefix — folding it into the credentials router to save a file would break the rule that a router
 * owns one prefix on its first application, which is how rules stop being rules.
 *
 * ── WHY IT DOES NOT USE asyncRoute ──
 * The handler is not async. It responds from `spawn`'s `close` and `error` callbacks, so there is
 * no promise to reject and nothing for `asyncRoute` to catch. Wrapping it would look tidier and
 * mean nothing.
 */

export interface BackupRouterDeps {
  /** Repo root. Injected rather than derived from `import.meta.url` so a test can point elsewhere. */
  repoRoot: string;
}

export function backupRouter(deps: BackupRouterDeps): Router {
  const router = Router();

  router.post('/run', (_req, res) => {
    const script = path.join(deps.repoRoot, 'scripts/backup-to-drive.sh');
    const child = spawn('bash', [script], { cwd: deps.repoRoot });

    // stdout and stderr are interleaved into one buffer on purpose: this is shown verbatim in the
    // UI, and a script's progress and its complaints only make sense in the order they happened.
    let output = '';
    child.stdout.on('data', (d) => { output += d.toString(); });
    child.stderr.on('data', (d) => { output += d.toString(); });

    child.on('close', (exitCode) => {
      // 200 with `success: false` rather than a 5xx: the request succeeded, the backup did not, and
      // the output is the point. A 500 would make the UI show a transport error instead of the log.
      res.json({ success: exitCode === 0, output });
    });
    child.on('error', (err) => {
      // This one IS a server fault — the script could not be started at all (missing, not
      // executable, no bash).
      res.status(500).json({ success: false, output: `${output}\n${err.message}` });
    });
  });

  return router;
}
