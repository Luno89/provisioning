import type { Router } from 'express';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { backupRouter } from './backup.js';
import { fakeChild } from '../testing/fake-child.js';
import { PERSON, routesInProcess } from '../../platform/testing/routes.js';

const on = (router: Router) => routesInProcess({ prefix: '/api/backup', router: () => router, user: PERSON });

function script(): { child: ChildProcessWithoutNullStreams; emit: (stream: 'stdout' | 'stderr' | 'child', event: string, ...args: unknown[]) => void } {
  const { child, events, stdout, stderr } = fakeChild();
  const sources = { stdout, stderr, child: events };
  return { child, emit: (stream, event, ...args) => sources[stream].emit(event, ...args) };
}

describe('/api/backup/run', () => {
  it('runs the backup script from the repository and answers with what it printed', async () => {
    const { child, emit } = script();
    const started: { command: string; args: string[]; cwd: string | undefined }[] = [];
    const router = backupRouter({ repoRoot: '/repo', startScript: (command, args, options) => { started.push({ command, args, cwd: options?.cwd }); setTimeout(() => { emit('stdout', 'data', Buffer.from('copied\n')); emit('stderr', 'data', Buffer.from('warn\n')); emit('child', 'close', 0); }); return child; } });
    const answer = await (await on(router)).post('/api/backup/run');
    expect(started).toEqual([{ command: 'bash', args: ['/repo/scripts/backup-to-drive.sh'], cwd: '/repo' }]);
    expect(answer.data).toEqual({ success: true, output: 'copied\nwarn\n' });
  });

  it('says the backup did not succeed when the script exits with an error', async () => {
    const { child, emit } = script();
    const router = backupRouter({ repoRoot: '/repo', startScript: () => { setTimeout(() => { emit('stderr', 'data', Buffer.from('no drive')); emit('child', 'close', 2); }); return child; } });
    expect((await (await on(router)).post('/api/backup/run')).data).toEqual({ success: false, output: 'no drive' });
  });

  it('answers 500 with the reason when the script cannot be started', async () => {
    const { child, emit } = script();
    const router = backupRouter({ repoRoot: '/repo', startScript: () => { setTimeout(() => emit('child', 'error', new Error('spawn bash ENOENT'))); return child; } });
    const answer = await (await on(router)).post('/api/backup/run');
    expect(answer.status).toBe(500);
    expect(answer.data).toEqual({ success: false, output: '\nspawn bash ENOENT' });
  });
});
