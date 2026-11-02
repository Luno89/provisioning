import { beforeEach, describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import type { ToolDefinition } from '@koala/agent-engine';
import type { EditableTool, EngineToolService } from '../services/EngineToolService.js';
import { TEST_USER } from '../../platform/routes/test-harness.js';
import { routesInProcess, type InProcessRoutes } from '../../platform/testing/routes.js';
import { engineToolsRouter } from './engine-tools.js';

const definition: ToolDefinition = {
  name: 'count_lines', summary: 'Counts the lines', binding: 'environment', effect: 'read', idempotent: false, openWorld: false, returns: 'a number', failures: [],
  parameters: { type: 'object', properties: {} }, command: 'wc -l',
};
const editable: EditableTool = { ...definition, mine: true, grantedTo: ['executor'] };

let tools: ReturnType<typeof mock<EngineToolService>>;
let app: InProcessRoutes;

beforeEach(async () => {
  tools = mock<EngineToolService>();
  app = await routesInProcess({ prefix: '/api/engine-tools', router: () => engineToolsRouter({ tools }) });
});

describe('/api/engine-tools', () => {
  it('lists the tools the signed-in person can see', async () => {
    tools.list.calledWith(TEST_USER.id).mockResolvedValue([editable]);
    expect(await app.get('/api/engine-tools')).toMatchObject({ status: 200, data: { tools: [{ name: 'count_lines', grantedTo: ['executor'] }] } });
  });

  it('reads one tool, and says when there is none', async () => {
    tools.get.calledWith(TEST_USER.id, 'count_lines').mockResolvedValue(editable);
    expect(await app.get('/api/engine-tools/count_lines')).toMatchObject({ status: 200, data: { tool: { name: 'count_lines' } } });
    expect(await app.get('/api/engine-tools/ghost')).toMatchObject({ status: 404, data: { error: 'There is no tool with that name' } });
  });

  it('saves the body as the person when it names the tool in the address, and says what is rebuilding', async () => {
    tools.save.calledWith(TEST_USER.id, matches((body) => (body as { name?: string }).name === 'count_lines')).mockResolvedValue({ saved: true, tool: editable, rebuilding: ['executor'], failed: [{ agent: 'planner', detail: 'no registry' }] });
    expect(await app.put('/api/engine-tools/count_lines', definition)).toMatchObject({ status: 200, data: { tool: { name: 'count_lines' }, rebuilding: ['executor'], failed: [{ agent: 'planner', detail: 'no registry' }] } });
  });

  it('refuses a body that names another tool, before the service is asked', async () => {
    expect(await app.put('/api/engine-tools/count_lines', { ...definition, name: 'other' })).toMatchObject({ status: 400, data: { error: 'the tool in the body is not called "count_lines"' } });
    expect(tools.save).not.toHaveBeenCalled();
  });

  it('answers a tool that does not hold together with each problem', async () => {
    tools.save.mockResolvedValue({ saved: false, problems: ['it needs a command'] });
    expect(await app.put('/api/engine-tools/count_lines', definition)).toMatchObject({ status: 400, data: { error: 'The tool does not hold together', problems: ['it needs a command'] } });
  });

  it('deletes the person\'s own copy, and says when they have none', async () => {
    tools.remove.calledWith(TEST_USER.id, 'count_lines').mockResolvedValue(true);
    tools.remove.calledWith(TEST_USER.id, 'ghost').mockResolvedValue(false);
    expect(await app.delete('/api/engine-tools/count_lines')).toMatchObject({ status: 200, data: { ok: true } });
    expect(await app.delete('/api/engine-tools/ghost')).toMatchObject({ status: 404, data: { error: 'You have no copy of that tool to delete' } });
  });
});
