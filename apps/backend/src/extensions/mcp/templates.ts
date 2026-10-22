import type { McpServerTemplate } from '../../engine/lib/mcp-servers.js';
import { SHARED_BROWSERS } from '../../engine/lib/browser-tests.js';

const PORT = 8931;

export const PLAYWRIGHT: McpServerTemplate = {
  id: 'playwright',
  name: 'playwright',
  summary: 'A headless Chromium the agent drives: open pages, read them as an accessibility snapshot, click, type, fill forms, read the console and network.',
  runs: {
    where: 'workspace',
    languages: ['node'],
    needs: ['playwright-mcp'],
    start: `PLAYWRIGHT_BROWSERS_PATH=${SHARED_BROWSERS} playwright-mcp --browser chromium --headless --isolated --image-responses omit --port ${PORT} --host 127.0.0.1 --allowed-hosts 127.0.0.1:${PORT}`,
    port: PORT,
    path: '/mcp',
  },
  omit: ['browser_take_screenshot', 'browser_run_code_unsafe'],
  notes: 'Pages are read with browser_snapshot, an accessibility tree with a ref for each element; click and type by those refs. Screenshots are left out: the models here read text.',
};

export const MCP_SERVER_TEMPLATES: readonly McpServerTemplate[] = [PLAYWRIGHT];
