import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { SecretRequest } from '../lib/secret-requests.js';
import { CALLER, get, post } from '../testing/route-call.js';
import type { SecretRequestService } from '../services/SecretRequestService.js';
import { secretRequestsRouter } from './secret-requests.js';

const request = (over: Partial<SecretRequest> = {}): SecretRequest => ({
  id: 'r1', ownerId: CALLER.id, projectId: 'p1', key: 'API_KEY', description: 'the key', secretReference: 'secret://p1/API_KEY', status: 'requested', createdAt: 't', updatedAt: 't', ...over,
});

function setUp() {
  const secrets = mock<SecretRequestService>();
  return { secrets, router: secretRequestsRouter({ secrets }) };
}

describe('listing secret requests', () => {
  it('passes only the text filters it was given', async () => {
    const { secrets, router } = setUp();
    secrets.list.mockResolvedValue([request()]);
    expect(await get(router, '/?projectId=p1&treeId=t1')).toMatchObject({ status: 200, body: [{ id: 'r1' }] });
    expect(secrets.list).toHaveBeenLastCalledWith(CALLER.id, { conversationId: undefined, projectId: 'p1', treeId: 't1' });
    await get(router, '/?conversationId=c1');
    expect(secrets.list).toHaveBeenLastCalledWith(CALLER.id, { conversationId: 'c1', projectId: undefined, treeId: undefined });
  });
});

describe('answering a secret request', () => {
  it('submits the typed value and answers the request as it now stands', async () => {
    const { secrets, router } = setUp();
    secrets.submit.calledWith(CALLER.id, 'r1', 's3cret').mockResolvedValue({ ok: true, request: request({ status: 'provided' }) });
    expect(await post(router, '/r1/submit', { value: 's3cret' })).toMatchObject({ status: 200, body: { status: 'provided' } });
  });

  it('submits an empty value when the body has none or not text, leaving the service to refuse it', async () => {
    const { secrets, router } = setUp();
    secrets.submit.mockResolvedValue({ ok: false, status: 400, error: 'Enter a value' });
    expect(await post(router, '/r1/submit', { value: 5 })).toEqual({ status: 400, body: { error: 'Enter a value' } });
    expect(secrets.submit).toHaveBeenLastCalledWith(CALLER.id, 'r1', '');
    await post(router, '/r1/submit');
    expect(secrets.submit).toHaveBeenLastCalledWith(CALLER.id, 'r1', '');
  });

  it('dismisses a request, or passes on why it cannot be', async () => {
    const { secrets, router } = setUp();
    secrets.dismiss.calledWith(CALLER.id, 'r1').mockResolvedValue({ ok: true, request: request({ status: 'dismissed' }) });
    secrets.dismiss.calledWith(CALLER.id, 'r2').mockResolvedValue({ ok: false, status: 404, error: 'Secret request not found' });
    expect(await post(router, '/r1/dismiss')).toMatchObject({ status: 200, body: { status: 'dismissed' } });
    expect(await post(router, '/r2/dismiss')).toEqual({ status: 404, body: { error: 'Secret request not found' } });
  });
});
