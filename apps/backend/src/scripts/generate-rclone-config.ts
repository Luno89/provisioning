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
  const { createDatabase } = await import('../lib/db-interface.js');
  const { decryptValue } = await import('../lib/crypto.js');

  const jwtSecret = process.env.JWT_SECRET;
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!jwtSecret || !clientId || !clientSecret) process.exit(1);

  const db = createDatabase() as any;
  if (typeof db.init === 'function') await db.init();

  const users = await db.getUsers();
  const user = users.find((u: any) => u.credentials?.googledrive?.refreshToken);
  if (!user) process.exit(1);

  const gd = user.credentials.googledrive;
  let refreshToken: string;
  try {
    refreshToken = decryptValue(gd.refreshToken, jwtSecret);
  } catch {
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
    } catch {
    }
  }

  const outPath = path.join(ROOT, '.rclone-runtime.conf');
  await fs.writeFile(outPath, lines.join('\n'), { mode: 0o600 });
  process.stdout.write(outPath);
}

main().catch(() => process.exit(1));
