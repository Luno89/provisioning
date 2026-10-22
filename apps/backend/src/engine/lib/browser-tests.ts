import { E2E_REPORT, E2E_ROOT, E2E_RUNNER, PLAYWRIGHT_VERSION, SHARED_BROWSERS_PATH } from './e2e.js';
import { E2E_RESULTS_DIR } from '../../files/lib/artifacts.js';

export const SHARED_BROWSERS = SHARED_BROWSERS_PATH;
export const KOALA_E2E_AT = `/usr/local/bin/${E2E_RUNNER}`;
export const CHROMIUM_LIBRARIES = 'nss atk at-spi2-atk cups-libs libdrm libxkbcommon libXcomposite libXdamage libXrandr libXfixes mesa-libgbm pango cairo alsa-lib';

export const APP_E2E_SCRIPT = [
  '#!/bin/bash',
  'set -u',
  `say() { echo "${E2E_RUNNER}: $*"; }`,
  '[ $# -gt 0 ] || set -- e2e',
  `export PLAYWRIGHT_BROWSERS_PATH="\${PLAYWRIGHT_BROWSERS_PATH:-${SHARED_BROWSERS}}"`,
  'if [ ! -f package.json ]; then',
  '  say "FAILED — there is no package.json here, so there is no app to serve"',
  '  exit 1',
  'fi',
  'config=""',
  'for candidate in playwright.config.ts playwright.config.mts playwright.config.js playwright.config.mjs; do',
  '  if [ -f "$candidate" ]; then config="$candidate"; break; fi',
  'done',
  'if [ -z "$config" ]; then',
  '  say "FAILED — there is no playwright.config.ts here; its webServer is what starts the app for the tests"',
  '  exit 1',
  'fi',
  'if [ ! -d node_modules ]; then',
  '  say "installing the project\'s packages"',
  '  if ! { npm ci --no-audit --no-fund || npm install --no-audit --no-fund; } > /tmp/koala-e2e-npm.log 2>&1; then',
  '    tail -n 20 /tmp/koala-e2e-npm.log',
  '    say "FAILED — npm could not install the project\'s packages"',
  '    exit 1',
  '  fi',
  'fi',
  'if [ -x node_modules/.bin/playwright ]; then',
  '  runner=node_modules/.bin/playwright',
  'else',
  '  runner=playwright',
  '  export NODE_PATH="$(npm root -g)"',
  'fi',
  'where=$("$runner" install --dry-run chromium 2>/dev/null | sed -n \'s/^ *Install location: *//p\' | head -n 1)',
  'if [ -z "$where" ] || [ ! -d "$where" ]; then',
  '  export PLAYWRIGHT_BROWSERS_PATH="${XDG_CACHE_HOME:-$HOME/.cache}/ms-playwright"',
  '  say "Playwright $("$runner" --version 2>/dev/null) is not the one this workspace has Chromium for; fetching its own into $PLAYWRIGHT_BROWSERS_PATH"',
  '  if ! "$runner" install chromium > /tmp/koala-e2e-browser.log 2>&1; then',
  '    tail -n 20 /tmp/koala-e2e-browser.log',
  `    say "FAILED — Playwright $("$runner" --version 2>/dev/null) has no Chromium here and could not fetch one; the workspace has Chromium for @playwright/test ${PLAYWRIGHT_VERSION}"`,
  '    exit 1',
  '  fi',
  'fi',
  `mkdir -p ${E2E_ROOT}`,
  'status=0',
  `PLAYWRIGHT_JSON_OUTPUT_NAME="$PWD/${E2E_REPORT}" "$runner" test "$@" --config "$config" --reporter=line,json --output="$PWD/${E2E_RESULTS_DIR}" || status=$?`,
  'if [ "$status" -eq 0 ]; then say PASSED; else say FAILED; fi',
  'exit "$status"',
].join('\n') + '\n';

export const KOALA_E2E_NEED = E2E_RUNNER;
export const TURN_ON_BROWSER_TESTS = `give the workspace the ${E2E_RUNNER} dependency (change_workspace with needs: ["${E2E_RUNNER}"], or "needs": ["${E2E_RUNNER}"] in .koala/workspace.json), which builds Playwright, Chromium and ${E2E_RUNNER} into it`;

export const browserTestsMissing = (request: { url?: string | undefined }): string =>
  `${request.url ? 'this workspace has no Playwright to run them with' : `this workspace's image has no ${E2E_RUNNER}, so it cannot serve its app to a browser`}; ${TURN_ON_BROWSER_TESTS}`;

export function checksNeed(checks: { e2e?: { url?: string | undefined } | undefined } | undefined): string[] {
  if (!checks?.e2e) return [];
  return [checks.e2e.url ? 'playwright' : E2E_RUNNER];
}
