import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const execFileAsync = promisify(execFile);

export interface SshKeypair {
  privateKey: string;
  publicKey: string;
}

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
