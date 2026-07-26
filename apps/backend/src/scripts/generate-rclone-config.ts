/**
 * generate-rclone-config.ts — Bridges the Google Drive OAuth credentials connected in-app
 * (Account → Backup Destinations → CloudAccounts.tsx, via /api/credentials/googledrive/connect)
 * into a runtime-only rclone.conf, so scripts/backup-to-drive.sh doesn't require a manually-run
 * `rclone config`.
 *
 * Picks the first user with googledrive credentials stored — this platform is local-first /
 * single-operator by design (see CLAUDE.md), so "whoever connected Drive" is unambiguous.
 *
 * On success: prints the generated config's path to stdout and exits 0.
 * On failure (no user has connected Drive yet, missing GOOGLE_CLIENT_ID/SECRET, etc.): exits 1
 * with nothing on stdout — callers should fall back to rclone's own default config in that case
 * (a user who ran `rclone config` by hand, per the platform's original setup docs, still works).
 */
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../../../');

// quiet: true — dotenv's startup banner goes to stdout by default, which would otherwise land
// in the middle of the single-line path this script is meant to print on success (the caller,
// scripts/backup-to-drive.sh, captures stdout directly to decide whether generation worked).
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

  // expiry left in the past forces rclone to refresh on first use rather than trusting a
  // (nonexistent) access_token — only the refresh_token needs to actually be valid here.
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
      // No usable backup password — secrets upload will be skipped by the caller, everything
      // else (Mongo, k3d-storage) still works off the [gdrive] remote alone.
    }
  }

  const outPath = path.join(ROOT, '.rclone-runtime.conf');
  await fs.writeFile(outPath, lines.join('\n'), { mode: 0o600 });
  process.stdout.write(outPath);
}

main().catch(() => process.exit(1));
