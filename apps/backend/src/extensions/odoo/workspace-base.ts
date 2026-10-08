import type { BaseImage } from '@koala/agent-engine';
import { ODOO_CHECK_SCRIPT } from './odoo-check.js';
import { KOALA_E2E_SCRIPT, ODOO_E2E_SCRIPT } from './odoo-e2e.js';

export const ODOO_VERSION = '18';
export const ODOO_IMAGE = `odoo:${ODOO_VERSION}`;
export const ODOO_CHECK = '/usr/local/bin/odoo-check';
export const ODOO_E2E = '/usr/local/bin/odoo-e2e';
export const KOALA_E2E = '/usr/local/bin/koala-e2e';
export const PLAYWRIGHT_VERSION = '1.48.2';
export const PLAYWRIGHT_BROWSERS = '/ms-playwright';

export const HELM_VERSION = 'v3.15.1';

const PGDG_KEY = 'https://www.postgresql.org/media/keys/ACCC4CF8.asc';
const PGDG_LIST = 'deb [signed-by=/usr/share/keyrings/pgdg.gpg] http://apt.postgresql.org/pub/repos/apt noble-pgdg main';


const base64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export const ODOO_BASE: BaseImage = {
  id: 'odoo',
  image: ODOO_IMAGE,
  provides: ['bash', 'git', 'python3', 'odoo', 'odoo-check', 'odoo-e2e', 'koala-e2e', 'postgres', 'psql', 'helm', 'node', 'npm', 'playwright', 'curl', 'tar'],
  env: [
    { name: 'PLAYWRIGHT_BROWSERS_PATH', value: PLAYWRIGHT_BROWSERS },
    { name: 'NODE_PATH', value: '/usr/local/lib/node_modules' },
  ],
  setup: [
    {
      via: 'script',
      run: [
        'apt-get update',
        'apt-get install -y --no-install-recommends ca-certificates curl gnupg git',
        `curl -fsSL ${PGDG_KEY} | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg`,
        `echo "${PGDG_LIST}" > /etc/apt/sources.list.d/pgdg.list`,
        'apt-get update',
        'apt-get install -y --no-install-recommends postgresql-18',
        'rm -rf /var/lib/apt/lists/*',
      ].join(' && '),
    },
    {
      via: 'script',
      run: `curl -fsSL https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz | tar -xz -C /tmp linux-amd64/helm && mv /tmp/linux-amd64/helm /usr/local/bin/helm && rm -rf /tmp/linux-amd64`,
    },
    {
      via: 'script',
      run: [
        'apt-get update',
        'apt-get install -y --no-install-recommends nodejs npm',
        'rm -rf /var/lib/apt/lists/*',
        `npm install -g @playwright/test@${PLAYWRIGHT_VERSION}`,
        `PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS} npx -y playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium`,
        `chmod -R a+rX ${PLAYWRIGHT_BROWSERS}`,
      ].join(' && '),
    },
    {
      via: 'script',
      run: `echo ${base64(ODOO_E2E_SCRIPT)} | base64 -d > ${ODOO_E2E} && chmod 755 ${ODOO_E2E}`,
    },
    {
      via: 'script',
      run: `echo ${base64(KOALA_E2E_SCRIPT)} | base64 -d > ${KOALA_E2E} && chmod 755 ${KOALA_E2E}`,
    },
    {
      via: 'script',
      run: `echo ${base64(ODOO_CHECK_SCRIPT)} | base64 -d > ${ODOO_CHECK} && chmod 755 ${ODOO_CHECK}`,
    },
  ],
};
