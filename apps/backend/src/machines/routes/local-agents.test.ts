import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { callRouter, PERSON } from '../testing/call-router.js';
import type { MachineService, MachineView } from '../services/MachineService.js';
import { localAgentsRouter } from './local-agents.js';

type Machines = Pick<MachineService, 'list' | 'createJoinCode' | 'setManualAgents' | 'installAdapter' | 'remove'>;

let machines: ReturnType<typeof mock<Machines>>;

const view = (id: string): MachineView => ({ id, name: id, rootDir: '/x', createdAt: 't', online: false, tokenExpired: false, agents: [], manualAgents: [] });

const PREFIX = '/api/mesh/local-agents';

const app = {
  get: (path: string) => call('GET', path),
  post: (path: string, body?: unknown) => call('POST', path, body),
  put: (path: string, body?: unknown) => call('PUT', path, body),
  delete: (path: string) => call('DELETE', path),
};

async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) {
  const answer = await callRouter(localAgentsRouter({ machines }), PREFIX, { method, path: path.slice(PREFIX.length), body });
  return { status: answer.status, data: answer.body };
}

beforeEach(() => {
  machines = mock<Machines>();
});

describe('/api/mesh/local-agents', () => {
  it('lists the signed-in person\'s machines', async () => {
    machines.list.mockResolvedValue([view('dev-mine')]);
    expect(await app.get('/api/mesh/local-agents')).toMatchObject({ status: 200, data: [{ id: 'dev-mine' }] });
    expect(machines.list).toHaveBeenCalledWith(PERSON.id);
  });

  it('gives a command to add a machine with, answering 201', async () => {
    machines.createJoinCode.mockResolvedValue({ code: 'abc', command: 'curl … | sh -s -- abc', expiresAt: 't' });
    expect(await app.post('/api/mesh/local-agents/join-code')).toMatchObject({ status: 201, data: { code: 'abc', command: 'curl … | sh -s -- abc' } });
    expect(machines.createJoinCode).toHaveBeenCalledWith(PERSON.id);
  });

  it('keeps the agents the body lists on the machine the address names, and answers a refusal with its status and words', async () => {
    machines.setManualAgents.mockResolvedValueOnce({ ok: true, value: view('dev-hand') });
    expect(await app.put('/api/mesh/local-agents/dev-hand/agents', { agents: [{ id: 'pi', command: 'pi' }] })).toMatchObject({ status: 200, data: { id: 'dev-hand' } });
    expect(machines.setManualAgents).toHaveBeenCalledWith(PERSON.id, 'dev-hand', [{ id: 'pi', command: 'pi' }]);
    machines.setManualAgents.mockResolvedValueOnce({ ok: false, status: 400, error: 'pi needs the command that starts it' });
    expect(await app.put('/api/mesh/local-agents/dev-hand/agents', { agents: [{ id: 'pi', command: '' }] })).toMatchObject({ status: 400, data: { error: 'pi needs the command that starts it' } });
    machines.setManualAgents.mockResolvedValueOnce({ ok: false, status: 404, error: 'no such machine' });
    await app.put('/api/mesh/local-agents/dev-theirs/agents');
    expect(machines.setManualAgents).toHaveBeenLastCalledWith(PERSON.id, 'dev-theirs', undefined);
  });

  it('asks the machine to install an agent\'s adapter and says what came of it, or why it would not', async () => {
    machines.installAdapter.mockResolvedValueOnce({ ok: true, value: { ok: true, output: 'added 1 package' } });
    expect(await app.post('/api/mesh/local-agents/dev-adapter/agents/claude/install')).toMatchObject({ status: 200, data: { ok: true, output: 'added 1 package' } });
    expect(machines.installAdapter).toHaveBeenCalledWith(PERSON.id, 'dev-adapter', 'claude');
    machines.installAdapter.mockResolvedValueOnce({ ok: false, status: 409, error: 'Adapter is not connected, so nothing can be installed on it' });
    expect(await app.post('/api/mesh/local-agents/dev-adapter/agents/claude/install')).toMatchObject({ status: 409, data: { error: 'Adapter is not connected, so nothing can be installed on it' } });
  });

  it('removes a machine the person owns, and says when there is none', async () => {
    machines.remove.mockResolvedValueOnce(true);
    expect(await app.delete('/api/mesh/local-agents/dev-delete-me')).toMatchObject({ status: 200, data: { success: true } });
    expect(machines.remove).toHaveBeenCalledWith(PERSON.id, 'dev-delete-me');
    machines.remove.mockResolvedValueOnce(false);
    expect(await app.delete('/api/mesh/local-agents/dev-not-mine')).toMatchObject({ status: 404, data: { error: 'Device not found' } });
  });
});
