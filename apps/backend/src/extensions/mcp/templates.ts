import type { McpServerTemplate } from '../../lib/mcp-servers.js';

export const PLAYWRIGHT_MCP_VERSION = '0.0.83';
const BROWSERS = '/opt/ms-playwright';
const PLAYWRIGHT_CLI = '"$(npm root -g)/@playwright/mcp/node_modules/playwright/cli.js"';
const CHROMIUM_LIBRARIES = 'nss atk at-spi2-atk cups-libs libdrm libxkbcommon libXcomposite libXdamage libXrandr libXfixes mesa-libgbm pango cairo alsa-lib';
const PORT = 8931;

export const PLAYWRIGHT: McpServerTemplate = {
  id: 'playwright',
  name: 'playwright',
  summary: 'A headless Chromium the agent drives: open pages, read them as an accessibility snapshot, click, type, fill forms, read the console and network.',
  runs: {
    where: 'workspace',
    languages: ['node'],
    install: [
      { via: 'npm', packages: [`@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`] },
      {
        via: 'script',
        run: [
          `if command -v apt-get >/dev/null 2>&1; then PLAYWRIGHT_BROWSERS_PATH=${BROWSERS} node ${PLAYWRIGHT_CLI} install --with-deps chromium;`,
          `else (command -v microdnf >/dev/null 2>&1 && microdnf install -y ${CHROMIUM_LIBRARIES} || dnf install -y --setopt=install_weak_deps=False ${CHROMIUM_LIBRARIES}) && PLAYWRIGHT_BROWSERS_PATH=${BROWSERS} node ${PLAYWRIGHT_CLI} install chromium; fi`,
          `&& chmod -R a+rX ${BROWSERS}`,
        ].join(' '),
      },
    ],
    needsBinaries: ['node', 'curl'],
    start: `PLAYWRIGHT_BROWSERS_PATH=${BROWSERS} playwright-mcp --browser chromium --headless --isolated --image-responses omit --port ${PORT} --host 127.0.0.1 --allowed-hosts 127.0.0.1:${PORT}`,
    port: PORT,
    path: '/mcp',
  },
  omit: ['browser_take_screenshot', 'browser_run_code_unsafe'],
  notes: 'Pages are read with browser_snapshot, an accessibility tree with a ref for each element; click and type by those refs. Screenshots are left out: the models here read text.',
};

export const MCP_SERVER_TEMPLATES: readonly McpServerTemplate[] = [PLAYWRIGHT];
