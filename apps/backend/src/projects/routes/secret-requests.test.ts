import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { SecretRequest } from '../lib/secret-requests.js';
import { TEST_USER } from '../../platform/routes/test-harness.js';
import { routesInProcess, type RouteAnswer } from '../../platform/testing/routes.js';
import type { SecretRequestService } from '../services/SecretRequestService.js';
import { secretRequestsRouter } from './secret-requests.js';

const request = (over: Partial<SecretRequest> = {}): SecretRequest => ({
  id: 'r1', ownerId: TEST_USER.id, projectId: 'p1', key: 'API_KEY', description: 'the key', secretReference: 'secret://p1/API_KEY', status: 'requested', createdAt: 't', updatedAt: 't', ...over,
});

const plain = ({ status, data }: RouteAnswer) => ({ status, body: data });

async function setUp() {
  const secrets = mock<SecretRequestService>();
  const routes = await routesInProcess({ prefix: '/', router: () => secretRequestsRouter({ secrets }) });
  return { secrets, routes };
}

describe('listing secret requests', () => {
  it('passes only the text filters it was given', async () => {
    const { secrets, routes } = await setUp();
    secrets.list.mockResolvedValue([request()]);
    expect(await routes.get('/?projectId=p1&treeId=t1')).toMatchObject({ status: 200, data: [{ id: 'r1' }] });
    expect(secrets.list).toHaveBeenLastCalledWith(TEST_USER.id, { conversationId: undefined, projectId: 'p1', treeId: 't1' });
    await routes.get('/?conversationId=c1');
    expect(secrets.list).toHaveBeenLastCalledWith(TEST_USER.id, { conversationId: 'c1', projectId: undefined, treeId: undefined });
  });
});

describe('answering a secret request', () => {
  it('submits the typed value and answers the request as it now stands', async () => {
    const { secrets, routes } = await setUp();
    secrets.submit.calledWith(TEST_USER.id, 'r1', 's3cret').mockResolvedValue({ ok: true, request: request({ status: 'provided' }) });
    expect(await routes.post('/r1/submit', { value: 's3cret' })).toMatchObject({ status: 200, data: { status: 'provided' } });
  });

  it('submits an empty value when the body has none or not text, leaving the service to refuse it', async () => {
    const { secrets, routes } = await setUp();
    secrets.submit.mockResolvedValue({ ok: false, status: 400, error: 'Enter a value' });
    expect(plain(await routes.post('/r1/submit', { value: 5 }))).toEqual({ status: 400, body: { error: 'Enter a value' } });
    expect(secrets.submit).toHaveBeenLastCalledWith(TEST_USER.id, 'r1', '');
    await routes.post('/r1/submit');
    expect(secrets.submit).toHaveBeenLastCalledWith(TEST_USER.id, 'r1', '');
  });

  it('dismisses a request, or passes on why it cannot be', async () => {
    const { secrets, routes } = await setUp();
    secrets.dismiss.calledWith(TEST_USER.id, 'r1').mockResolvedValue({ ok: true, request: request({ status: 'dismissed' }) });
    secrets.dismiss.calledWith(TEST_USER.id, 'r2').mockResolvedValue({ ok: false, status: 404, error: 'Secret request not found' });
    expect(await routes.post('/r1/dismiss')).toMatchObject({ status: 200, data: { status: 'dismissed' } });
    expect(plain(await routes.post('/r2/dismiss'))).toEqual({ status: 404, body: { error: 'Secret request not found' } });
  });
});
