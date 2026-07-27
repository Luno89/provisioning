import { describe, it, expect } from 'vitest';
import { generateSshKeypair } from './ssh-keypair.js';

describe('generateSshKeypair', () => {
  it('produces a usable ed25519 OpenSSH pair', async () => {
    const { privateKey, publicKey } = await generateSshKeypair('provisioning-test');
    expect(privateKey).toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(publicKey).toMatch(/^ssh-ed25519 AAAA\S+ provisioning-test\s*$/);
  });

  it('leaves nothing on disk', async () => {
    // The private key is persisted encrypted by the caller. A copy left in a temp dir would be an
    // unencrypted credential for a machine that is reachable from the internet.
    const fs = await import('fs/promises');
    const os = await import('os');
    const before = (await fs.readdir(os.tmpdir())).filter((f) => f.startsWith('sshkeygen-'));
    await generateSshKeypair('provisioning-leak-check');
    const after = (await fs.readdir(os.tmpdir())).filter((f) => f.startsWith('sshkeygen-'));
    expect(after).toEqual(before);
  });

  it('generates a distinct pair per call', async () => {
    // Stability across ATTEMPTS comes from persisting one pair and reusing it, never from this
    // function returning the same thing twice — two different clusters must not share a key.
    const a = await generateSshKeypair('provisioning-a');
    const b = await generateSshKeypair('provisioning-b');
    expect(a.publicKey).not.toBe(b.publicKey);
  });
});
