import { LANGUAGE_DEPENDENCIES, type WorkspaceDependency } from '@koala/agent-engine';
import { PLAYWRIGHT_VERSION, E2E_RUNNER } from '../engine/lib/e2e.js';
import { APP_E2E_SCRIPT, CHROMIUM_LIBRARIES, KOALA_E2E_AT, SHARED_BROWSERS } from '../engine/lib/browser-tests.js';

export const PLAYWRIGHT_MCP_VERSION = '0.0.83';
const PLAYWRIGHT_MCP_CLI = '"$(npm root -g)/@playwright/mcp/node_modules/playwright/cli.js"';
const base64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

export const SHIPPED_DEPENDENCIES: readonly WorkspaceDependency[] = [
  ...LANGUAGE_DEPENDENCIES,
  {
    name: 'jq',
    summary: 'jq, for reading and reshaping JSON on the command line.',
    provides: ['jq'],
    install: [{ via: 'dnf', packages: ['jq'] }],
  },
  {
    name: 'chromium-libraries',
    summary: 'The system libraries a headless Chromium needs.',
    provides: [],
    libraries: ['libnss3.so', 'libgbm.so.1', 'libasound.so.2'],
    install: [{ via: 'script', run: `if command -v microdnf >/dev/null 2>&1; then microdnf install -y ${CHROMIUM_LIBRARIES} && microdnf clean all; else dnf install -y --setopt=install_weak_deps=False ${CHROMIUM_LIBRARIES} && dnf clean all; fi` }],
    onDebian: [{ via: 'script', run: `npx -y playwright@${PLAYWRIGHT_VERSION} install-deps chromium` }],
    needs: ['node'],
  },
  {
    name: 'playwright',
    summary: `Playwright ${PLAYWRIGHT_VERSION} with its Chromium in ${SHARED_BROWSERS}, for browser tests.`,
    provides: ['playwright'],
    needs: ['node', 'chromium-libraries'],
    install: [
      { via: 'npm', packages: [`@playwright/test@${PLAYWRIGHT_VERSION}`] },
      { via: 'script', run: `PLAYWRIGHT_BROWSERS_PATH=${SHARED_BROWSERS} playwright install chromium && chmod -R a+rX ${SHARED_BROWSERS}` },
    ],
  },
  {
    name: E2E_RUNNER,
    summary: `${E2E_RUNNER}: runs a project's Playwright specs against its own app, served by its playwright.config webServer, and reports each test.`,
    provides: [E2E_RUNNER],
    needs: ['playwright'],
    install: [{ via: 'script', run: `echo ${base64(APP_E2E_SCRIPT)} | base64 -d > ${KOALA_E2E_AT} && chmod 755 ${KOALA_E2E_AT}` }],
  },
  {
    name: 'playwright-mcp',
    summary: `The Playwright MCP server ${PLAYWRIGHT_MCP_VERSION} with its own Chromium, a browser an agent drives.`,
    provides: ['playwright-mcp'],
    needs: ['node', 'chromium-libraries'],
    install: [
      { via: 'npm', packages: [`@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`] },
      { via: 'script', run: `PLAYWRIGHT_BROWSERS_PATH=${SHARED_BROWSERS} node ${PLAYWRIGHT_MCP_CLI} install chromium && chmod -R a+rX ${SHARED_BROWSERS}` },
    ],
  },
];

export const ODOO_BASE_HAS = ['python', 'node', 'chromium-libraries', 'playwright', E2E_RUNNER, 'odoo-check', 'odoo-e2e', 'postgres', 'helm'];
