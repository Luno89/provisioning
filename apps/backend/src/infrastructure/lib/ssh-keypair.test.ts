import { describe, expect, it } from 'vitest';
import { recordingProcesses } from '@koala/engine-core/testing/processes';
import { generateSshKeypair } from './ssh-keypair.js';

describe('generateSshKeypair', () => {
  it('asks ssh-keygen for an ed25519 pair with no passphrase and the comment given', async () => {
    const keygen = recordingProcesses(() => ({ code: 1, stderr: 'Saving key failed: disk full\n' }));
    await expect(generateSshKeypair('koala-root-1234', keygen)).rejects.toThrow('Saving key failed: disk full');
    const [run] = keygen.ran;
    expect(run?.command).toBe('ssh-keygen');
    expect(run?.args.filter((arg) => !arg.includes('/'))).toEqual(['-t', 'ed25519', '-N', '', '-f', '-C', 'koala-root-1234']);
  });
});
