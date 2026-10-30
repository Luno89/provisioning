import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { breachedFrom, type BreachedPasswords } from '../lib/passwords.js';

export const BREACHED_PASSWORDS_FILE = fileURLToPath(new URL('../../../assets/breached-passwords.txt.gz', import.meta.url));

export const loadBreachedPasswords = (file = BREACHED_PASSWORDS_FILE): BreachedPasswords =>
  breachedFrom(gunzipSync(readFileSync(file)).toString('utf8'));
