import type { Router } from 'express';
import { describe, expect, it } from 'vitest';
import { recordingProcesses } from '@koala/engine-core/testing/processes';
import { backupRouter } from './backup.js';
import { PERSON, routesInProcess } from '../../platform/testing/routes.js';

const on = (router: Router) => routesInProcess({ prefix: '/api/backup', router: () => router, user: PERSON });

describe('/api/backup/run', () => {
  it('runs the backup script from the repository and answers with what it printed', async () => {
    const processes = recordingProcesses(() => ({ stdout: 'copied\n', stderr: 'warn\n' }));
    const answer = await (await on(backupRouter({ repoRoot: '/repo', processes }))).post('/api/backup/run');
    expect(processes.ran).toEqual([{ command: 'bash', args: ['/repo/scripts/backup-to-drive.sh'], cwd: '/repo' }]);
    expect(answer.data).toEqual({ success: true, output: 'copied\nwarn\n' });
  });

  it('says the backup did not succeed when the script exits with an error', async () => {
    const processes = recordingProcesses(() => ({ stderr: 'no drive', code: 2 }));
    expect((await (await on(backupRouter({ repoRoot: '/repo', processes }))).post('/api/backup/run')).data).toEqual({ success: false, output: 'no drive' });
  });

  it('answers 500 with the reason when the script cannot be started', async () => {
    const processes = recordingProcesses(() => undefined);
    const answer = await (await on(backupRouter({ repoRoot: '/repo', processes }))).post('/api/backup/run');
    expect(answer.status).toBe(500);
    expect(answer.data).toEqual({ success: false, output: '\nspawn bash ENOENT' });
  });
});
