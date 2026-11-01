import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../../../');

dotenv.config({ path: path.join(ROOT, 'apps/backend/.env'), quiet: true });

async function main() {
  const { createDatabase } = await import('../platform/index.js');
  const { decryptValue } = await import('../platform/index.js');

  const jwtSecret = (await import('../platform/index.js')).loadKeys(process.env).data;
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!jwtSecret || !clientId || !clientSecret) process.exit(1);

  const db = createDatabase();
  await db.init();

  const users = await db.accounts.getUsers();
  const gd = users.map((u) => u.credentials?.googledrive).find((drive) => drive?.refreshToken);
  if (!gd?.refreshToken) process.exit(1);

  let refreshToken: string;
  try {
    refreshToken = decryptValue(gd.refreshToken, jwtSecret);
  } catch (err) {
    process.stderr.write(`the Google Drive refresh token could not be decrypted: ${(err as Error).message}\n`);
    process.exit(1);
  }

  const rclonePath = path.join(ROOT, 'bin/rclone');
  const rclone = existsSync(rclonePath) ? rclonePath : 'rclone';

  const token = JSON.stringify({
    access_token: '',
    token_type: 'Bearer',
    refresh_token: refreshToken,
    expiry: '2000-01-01T00:00:00Z',
  });

  const lines = [
    '[gdrive]',
    'type = drive',
    `client_id = ${clientId}`,
    `client_secret = ${clientSecret}`,
    'scope = drive.file',
    `token = ${token}`,
    '',
  ];

  if (gd.backupPassword) {
    let backupPassword: string;
    try {
      backupPassword = decryptValue(gd.backupPassword, jwtSecret);
      const obscured = execFileSync(rclone, ['obscure', backupPassword]).toString().trim();
      lines.push(
        '[gdrive-crypt]',
        'type = crypt',
        'remote = gdrive:ProvisioningBackups/secrets-encrypted',
        `password = ${obscured}`,
        'filename_encryption = standard',
        '',
      );
    } catch (err) {
      process.stderr.write(`the backup encryption password could not be used, so the encrypted remote is left out: ${(err as Error).message}\n`);
    }
  }

  const outPath = path.join(ROOT, '.rclone-runtime.conf');
  await fs.writeFile(outPath, lines.join('\n'), { mode: 0o600 });
  process.stdout.write(outPath);
}

main().catch((err: Error) => {
  process.stderr.write(`the rclone config could not be written: ${err.message}\n`);
  process.exit(1);
});
