import { describe, expect, it } from 'vitest';
import { recordingProcesses } from '@koala/engine-core/testing/processes';
import { readOverSsh, runScriptOverSsh, sshAnswers } from './ssh-session.js';

const target = { host: '203.0.113.7', privateKey: 'KEY' };

describe('a script run on a server over ssh', () => {
  it('is handed to bash on the server, and each line it prints on either output is heard', async () => {
    const ssh = recordingProcesses(() => ({ stdout: 'one\r\ntwo\n', stderr: 'warned\nlast', code: 3 }));
    const lines: string[] = [];
    expect(await runScriptOverSsh(target, 'echo one; echo two', (line) => lines.push(line), ssh)).toBe(3);
    expect(lines).toEqual(['one', 'two', 'warned', 'last']);
    const [run] = ssh.ran;
    expect(run?.command).toBe('ssh');
    expect(run?.args.slice(-2)).toEqual(['root@203.0.113.7', 'bash -s']);
    expect(run?.input).toBe('echo one; echo two');
  });

  it('says the server answers only when the script ran there', async () => {
    expect(await sshAnswers(target, recordingProcesses(() => ({})))).toBe(true);
    expect(await sshAnswers(target, recordingProcesses(() => ({ code: 255 })))).toBe(false);
  });

  it('reads what a command printed, or says it failed on that server', async () => {
    expect(await readOverSsh(target, 'cat /etc/hostname', recordingProcesses(() => ({ stdout: 'box\n' })))).toBe('box');
    await expect(readOverSsh(target, 'cat /nope', recordingProcesses(() => ({ code: 1 })))).rejects.toThrow('cat on 203.0.113.7 ended with 1');
  });

  it('fails when ssh is not there', async () => {
    await expect(sshAnswers(target, recordingProcesses(() => undefined))).rejects.toThrow('ssh could not start');
  });
});
