import { describe, expect, it, vi } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import type { Principal } from '../../platform/lib/permissions.js';
import { PERSON, routesInProcess } from '../../platform/testing/routes.js';
import type { AccountRemovalService } from '../services/AccountRemovalService.js';
import { accountRouter } from './account.js';

type Removal = Pick<AccountRemovalService, 'preview' | 'remove'>;

const set = async () => {
  const removal = mock<Removal>();
  const clearSession = vi.fn();
  const confirmed = vi.fn(async () => undefined);
  const routes = await routesInProcess({ prefix: '/api/account', router: () => accountRouter({ removal, clearSession, confirmed }), user: PERSON });
  return { removal, clearSession, confirmed, routes };
};

describe('/api/account', () => {
  it('shows what removing the signed-in person\'s own account would take with it', async () => {
    const { removal, routes } = await set();
    removal.preview.calledWith(PERSON.id).mockResolvedValue({ email: PERSON.email, blockers: [] });
    expect((await routes.get('/api/account/removal')).data).toEqual({ email: PERSON.email, blockers: [] });
  });

  it('says there is no such account when there is none to preview', async () => {
    const { routes } = await set();
    const answer = await routes.get('/api/account/removal');
    expect(answer.status).toBe(404);
    expect(answer.data).toEqual({ error: 'There is no such account' });
  });

  it('starts the removal as the person asking, with what they typed, and signs them out', async () => {
    const { removal, clearSession, confirmed, routes } = await set();
    removal.remove.calledWith(
      matches<{ ownerId: string; requestedBy: string; confirm: string }>((request) => request.ownerId === PERSON.id && request.requestedBy === PERSON.id && request.confirm === PERSON.email),
      matches<Principal>((principal) => principal.id === PERSON.id),
      matches<() => Promise<unknown>>((proof) => typeof proof === 'function'),
    ).mockResolvedValue({ ok: true, state: { state: 'running', done: [] } });
    const answer = await routes.delete('/api/account', { body: { confirm: PERSON.email } });
    expect(answer.status).toBe(202);
    expect(answer.data).toEqual({ state: { state: 'running', done: [] } });
    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(confirmed).not.toHaveBeenCalled();
  });

  it('asks the proof the route was given, only when the service asks for it', async () => {
    const { removal, confirmed, routes } = await set();
    confirmed.mockResolvedValue(undefined);
    removal.remove.mockImplementation(async (_request, _principal, proven) => {
      await proven?.();
      return { ok: true, state: { state: 'none' } };
    });
    await routes.delete('/api/account', { body: { confirm: PERSON.email } });
    expect(confirmed).toHaveBeenCalledTimes(1);
  });

  it('keeps the session and answers with the refusal, whatever status it carries', async () => {
    const { removal, clearSession, routes } = await set();
    removal.remove.mockResolvedValue({ ok: false, refusal: { status: 409, error: 'The account cannot be removed yet', blockers: ['the app "odoo" is still deployed; remove it first'] } });
    const answer = await routes.delete('/api/account', { body: { confirm: PERSON.email } });
    expect(answer.status).toBe(409);
    expect(answer.data).toEqual({ status: 409, error: 'The account cannot be removed yet', blockers: ['the app "odoo" is still deployed; remove it first'] });
    expect(clearSession).not.toHaveBeenCalled();
  });

  it('takes a missing or non-text confirmation as an empty one', async () => {
    const { removal, routes } = await set();
    removal.remove.mockResolvedValue({ ok: false, refusal: { status: 400, error: 'Type the account\'s email to confirm' } });
    await routes.delete('/api/account', { body: { confirm: 7 } });
    await routes.delete('/api/account');
    expect(removal.remove.mock.calls.map(([request]) => request.confirm)).toEqual(['', '']);
  });
});
