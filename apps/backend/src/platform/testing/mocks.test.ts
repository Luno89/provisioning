import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import { succeeded, type ProcessRun, type Processes } from '@koala/engine-core/processes';
import type { WorkflowRun, Workflows } from '../lib/workflows.js';
import { interceptHttp } from './http.js';

const server = interceptHttp(http.get('https://api.example.test/things/:id', ({ params }) => HttpResponse.json({ id: params.id })));

describe('the mocks a unit test stands in for real dependencies with', () => {
  it('answers fetch through msw without opening a connection', async () => {
    expect(await (await fetch('https://api.example.test/things/7')).json()).toEqual({ id: '7' });
  });

  it('fails a request no handler expects, even to an address that answers', async () => {
    const error = await fetch('http://127.0.0.1:8099/').catch((err: Error) => err);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error & { cause?: unknown }).cause ?? error)).toMatch(/unhandled|no handler|MSW/i);
    server.resetHandlers();
  });

  it('answers a program by the arguments it was given, and only those', async () => {
    const processes = mock<Processes>();
    processes.run.calledWith(matches<ProcessRun>((run) => run.command === 'kubectl' && run.args.join(' ') === 'get ns')).mockResolvedValue({ code: 0, stdout: 'default\n', stderr: '' });
    expect(await succeeded(processes, { command: 'kubectl', args: ['get', 'ns'] })).toBe('default\n');
    expect(await processes.run({ command: 'kubectl', args: ['delete', 'ns', 'default'] })).toBeUndefined();
    expect(processes.run).toHaveBeenCalledTimes(2);
  });

  it('stands in for Temporal with the client\'s own types', async () => {
    const workflows = mock<Workflows>();
    const run = mock<WorkflowRun>();
    workflows.getHandle.calledWith('run-1').mockReturnValue(run);
    run.query.mockResolvedValue({ cancelled: true });
    expect(await workflows.getHandle('run-1').query('runState')).toEqual({ cancelled: true });
    expect(workflows.getHandle('run-2')).toBeUndefined();
  });
});
