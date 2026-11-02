import { describe, it, expect } from 'vitest';
import { generateSshKeypair } from './ssh-keypair.js';

describe('generateSshKeypair', () => {
  it('produces a usable ed25519 OpenSSH pair', async () => {
    const { privateKey, publicKey } = await generateSshKeypair('provisioning-test');
    expect(privateKey).toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(publicKey).toMatch(/^ssh-ed25519 AAAA\S+ provisioning-test\s*$/);
  });

  it('leaves nothing on disk', async () => {
    const fs = await import('fs/promises');
    const os = await import('os');
    const before = (await fs.readdir(os.tmpdir())).filter((f) => f.startsWith('sshkeygen-'));
    await generateSshKeypair('provisioning-leak-check');
    const after = (await fs.readdir(os.tmpdir())).filter((f) => f.startsWith('sshkeygen-'));
    expect(after).toEqual(before);
  });

  it('generates a distinct pair per call', async () => {
    const a = await generateSshKeypair('provisioning-a');
    const b = await generateSshKeypair('provisioning-b');
    expect(a.publicKey).not.toBe(b.publicKey);
  });
});
