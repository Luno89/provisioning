import { describe, expect, it, vi } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import type { Principal } from '../../platform/lib/permissions.js';
import { removalProgressOf, removalProgressToken, signJWT } from '../../platform/lib/auth.js';
import { PERSON, routesInProcess } from '../../platform/testing/routes.js';
import type { AccountRemovalService } from '../services/AccountRemovalService.js';
import { accountRouter } from './account.js';

type Removal = Pick<AccountRemovalService, 'preview' | 'remove' | 'removalProgress'>;

const KEY = 'progress-key';

const set = async (user: typeof PERSON | null = PERSON) => {
  const removal = mock<Removal>();
  const clearSession = vi.fn();
  const confirmed = vi.fn(async () => undefined);
  const routes = await routesInProcess({ prefix: '/api/account', router: () => accountRouter({ removal, clearSession, confirmed, progressKey: KEY }), user, open: user === null });
  return { removal, clearSession, confirmed, routes };
};

describe('the person\'s own page while their account is removed', () => {
  const removal = { startedAt: 'then', requestedBy: PERSON.id, state: { state: 'running' as const, done: [] } };

  it('hands the person, as their removal starts, what reads its progress for their account alone', async () => {
    const { removal: service, routes } = await set();
    service.remove.mockResolvedValue({ ok: true, state: { state: 'running', done: [] } });
    const answer = await routes.delete<{ progress: string }>('/api/account', { body: { confirm: PERSON.email } });
    expect(removalProgressOf(answer.data.progress, KEY)).toBe(PERSON.id);
  });

  it('shows the removal\'s progress to whoever holds it, signed in or not, and then that it is removed', async () => {
    const { removal: service, routes } = await set(null);
    service.removalProgress.calledWith('bob').mockResolvedValue({ removal });
    const progress = { authorization: `Bearer ${removalProgressToken('bob', KEY)}` };
    expect(await routes.get('/api/account/removal/progress', { headers: progress })).toMatchObject({ status: 200, data: { removal } });
    service.removalProgress.calledWith('bob').mockResolvedValue({ removed: true });
    expect(await routes.get('/api/account/removal/progress', { headers: progress })).toMatchObject({ status: 200, data: { removed: true } });
  });

  it('shows nothing without it, with one signed for something else or with another key, or once the account is not being removed', async () => {
    const { removal: service, routes } = await set();
    for (const headers of [{}, { authorization: 'Bearer nonsense' }, { authorization: `Bearer ${signJWT('oauth-state', { progressOf: PERSON.id }, KEY, 60)}` }, { authorization: `Bearer ${removalProgressToken(PERSON.id, 'other-key')}` }]) {
      expect(await routes.get('/api/account/removal/progress', { headers }), JSON.stringify(headers)).toMatchObject({ status: 401, data: { error: 'This does not show a removal' } });
    }
    expect(service.removalProgress).not.toHaveBeenCalled();
    expect(await routes.get('/api/account/removal/progress', { headers: { authorization: `Bearer ${removalProgressToken(PERSON.id, KEY)}` } })).toMatchObject({ status: 404, data: { error: 'This account is not being removed' } });
  });
});

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
    expect(answer.data).toEqual({ state: { state: 'running', done: [] }, progress: removalProgressToken(PERSON.id, KEY) });
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
