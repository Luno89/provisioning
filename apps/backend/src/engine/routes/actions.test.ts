import { beforeEach, describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import type { ProposalProgress } from '@koala/harness-types';
import type { ActionProposal } from '../lib/action-proposals.js';
import type { ActionService } from '../services/ActionService.js';
import { mountInProcess, PERSON, type InProcess } from '../testing/in-process.js';
import { actionsRouter } from './actions.js';

const card = (over: Partial<ActionProposal> = {}): ActionProposal => ({
  id: 'a1', ownerId: PERSON.id, kind: 'deploy_app', summary: 's', detail: [], params: {}, status: 'applied', createdAt: 'x', updatedAt: 'x', ...over,
});

let actions: ReturnType<typeof mock<ActionService>>;
let app: InProcess;

beforeEach(async () => {
  actions = mock<ActionService>();
  app = await mountInProcess({ prefix: '/api/actions', router: () => actionsRouter({ actions }) });
});

describe('/api/actions', () => {
  it('lists the cards of a conversation or a tree for the signed-in person', async () => {
    actions.list.mockResolvedValue([card()]);
    expect(await app.get('/api/actions?conversationId=c1&treeId=t1')).toMatchObject({ status: 200, data: [{ id: 'a1' }] });
    expect(actions.list).toHaveBeenCalledWith(PERSON.id, { conversationId: 'c1', treeId: 't1' });
  });

  it('lists without a filter when the query names none, and ignores one given twice', async () => {
    actions.list.mockResolvedValue([]);
    await app.get('/api/actions');
    expect(actions.list).toHaveBeenLastCalledWith(PERSON.id, { conversationId: undefined, treeId: undefined });
    await app.get('/api/actions?conversationId=a&conversationId=b');
    expect(actions.list).toHaveBeenLastCalledWith(PERSON.id, { conversationId: undefined, treeId: undefined });
  });

  it('applies a card as its owner, with who they are, and answers the card', async () => {
    actions.apply.calledWith(PERSON.id, 'a1', matches((principal) => (principal as { id?: string }).id === PERSON.id)).mockResolvedValue({ ok: true, proposal: card({ result: 'done' }) });
    expect(await app.post('/api/actions/a1/apply')).toMatchObject({ status: 200, data: { id: 'a1', status: 'applied', result: 'done' } });
  });

  it('answers a card that is not there, or already decided, with the service\'s status and words', async () => {
    actions.apply.mockResolvedValueOnce({ ok: false, status: 404, error: 'Proposal not found' });
    actions.apply.mockResolvedValueOnce({ ok: false, status: 409, error: 'This proposal is already applied.' });
    expect(await app.post('/api/actions/nope/apply')).toMatchObject({ status: 404, data: { error: 'Proposal not found' } });
    expect(await app.post('/api/actions/a1/apply')).toMatchObject({ status: 409, data: { error: 'This proposal is already applied.' } });
  });

  it('rejects a card for its owner', async () => {
    actions.reject.calledWith(PERSON.id, 'a1').mockResolvedValue({ ok: true, proposal: card({ status: 'rejected' }) });
    expect(await app.post('/api/actions/a1/reject')).toMatchObject({ status: 200, data: { status: 'rejected' } });
    actions.reject.calledWith(PERSON.id, 'a2').mockResolvedValue({ ok: false, status: 404, error: 'Proposal not found' });
    expect((await app.post('/api/actions/a2/reject')).status).toBe(404);
  });

  it('follows what a card started, and says when nothing is followed', async () => {
    const progress: ProposalProgress = { steps: [{ label: 'Added x', state: 'done' }], done: true };
    actions.progress.calledWith(PERSON.id, 'a1').mockResolvedValue(progress);
    expect(await app.get('/api/actions/a1/progress')).toMatchObject({ status: 200, data: progress });
    expect(await app.get('/api/actions/a2/progress')).toMatchObject({ status: 404, data: { error: 'nothing that card started is being followed' } });
  });

  it('answers a failure of the service as an error rather than hanging', async () => {
    actions.list.mockRejectedValue(new Error('the store is down'));
    expect(await app.get('/api/actions')).toMatchObject({ status: 500, data: { error: 'the store is down' } });
  });
});
