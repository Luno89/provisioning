/**
 * SSH keypair generation for provisioned VMs.
 *
 * Lives here rather than inside the provisioning activity because of a hard constraint from the
 * providers: **cloud VMs inject `authorized_keys` at creation time only.** Hetzner writes the key
 * into the image as the server boots; replacing the `hcloud_ssh_key` resource afterwards updates
 * Hetzner's own records and does nothing whatsoever to a machine that is already running.
 *
 * The consequence is unforgiving. If the keypair is generated inside the activity, every retry
 * mints a new one — and from the second attempt onward we are presenting a key the server has
 * never seen. That server is then permanently unreachable: `Permission denied (publickey)`, no
 * matter how many times it is retried, while still billing. Observed live, with the server created
 * at 21:45:22Z and the key it was supposedly using created at 22:00:17Z.
 *
 * So the key is generated ONCE, before the workflow starts, and persisted encrypted on the cluster
 * record. Every attempt — on any worker, after any restart — then uses the same key that was
 * actually baked into the machine.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const execFileAsync = promisify(execFile);

export interface SshKeypair {
  /** OpenSSH-format private key. Store encrypted; never log. */
  privateKey: string;
  /** `ssh-ed25519 AAAA... comment` — what the provider's ssh_key resource receives. */
  publicKey: string;
}

/**
 * Generates a fresh ed25519 keypair via ssh-keygen.
 *
 * ed25519 over RSA because every current Ubuntu cloud image accepts it and the keys are far
 * smaller; `-N ''` because nothing could supply a passphrase non-interactively later. The temp
 * files are removed before returning — the caller is responsible for persisting the material,
 * which is deliberately never left on disk here.
 */
export async function generateSshKeypair(comment: string): Promise<SshKeypair> {
  const keyPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), 'sshkeygen-')),
    'id_ed25519',
  );
  try {
    await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-C', comment]);
    const [privateKey, publicKey] = await Promise.all([
      fs.readFile(keyPath, 'utf-8'),
      fs.readFile(`${keyPath}.pub`, 'utf-8'),
    ]);
    return { privateKey, publicKey };
  } finally {
    await fs.rm(path.dirname(keyPath), { recursive: true, force: true });
  }
}
