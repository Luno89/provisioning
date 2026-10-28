import { describe, expect, it } from 'vitest';
import { recordFor, relayProblem, requestProblem } from './hub-board.js';
import { asPerson, withSharedRole, type SharedRole } from '../../platform/lib/permissions.js';

const as = (role: SharedRole) => withSharedRole(asPerson('member'), 'sp', role);

const board = {
  trees: [{ id: 't1' }],
  branches: [{ id: 'b1', treeId: 't1' }, { id: 'b2', treeId: 't1' }],
  leaves: [{ id: 'l1', branchId: 'b1' }, { id: 'l2', branchId: 'b1' }, { id: 'l3', branchId: 'b2' }],
  tasks: [{ id: 'k1' }],
  planProposals: [{ id: 'p1' }],
  conversations: [{ id: 'channel-x' }],
};

describe('what every member sees of a shared project', () => {
  it('shows every record whole, how it was worked included, and never the owner\'s id', () => {
    const leaf = { id: 'l1', ownerId: 'ann', branchId: 'b1', title: 'Pay', status: 'claimed', runId: 'r', claim: { evidence: 'diff', at: 'x' }, attempts: [{}], review: {}, drops: [], createdAt: 'a', updatedAt: 'b' };
    const { ownerId: _ownerId, ...whole } = leaf;
    expect(recordFor(leaf)).toEqual(whole);
    const chat = { id: 'c', ownerId: 'ann', kind: 'channel', modelId: 'm', messages: [{ role: 'assistant', content: 'done', at: '1', reasoning: 'thinking', toolCalls: [{}] }] };
    expect(recordFor(chat)).toMatchObject({ messages: [{ reasoning: 'thinking', toolCalls: [{}] }] });
    expect(recordFor(chat)).not.toHaveProperty('ownerId');
  });
});

describe('what each role may ask the owner\'s instance to do', () => {
  it('lets owners and collaborators change the work, and refuses a client', () => {
    expect(requestProblem('approve-plan', { proposalId: 'p1' }, as('collaborator'), 'sp', board)).toBeUndefined();
    expect(requestProblem('approve-plan', { proposalId: 'p1' }, as('client'), 'sp', board)).toEqual({ status: 403, why: 'only an owner or a collaborator can change the work' });
    expect(requestProblem('accept-task', { taskId: 'k1' }, as('owner'), 'sp', board)).toBeUndefined();
    expect(requestProblem('order-features', { treeId: 't1', branchIds: ['b1', 'b2'] }, as('client'), 'sp', board)).toEqual({ status: 403, why: 'only an owner or a collaborator can change the work' });
  });

  it('refuses anything that is not this project\'s, and an order that mixes features', () => {
    expect(requestProblem('approve-plan', { proposalId: 'elsewhere' }, as('owner'), 'sp', board)?.status).toBe(400);
    expect(requestProblem('order-stories', { branchId: 'b1', leafIds: ['l2', 'l1'] }, as('owner'), 'sp', board)).toBeUndefined();
    expect(requestProblem('order-stories', { branchId: 'b1', leafIds: ['l2', 'l3'] }, as('owner'), 'sp', board)?.status).toBe(400);
    expect(requestProblem('order-features', { treeId: 't1', branchIds: ['b2', 'b1'] }, as('owner'), 'sp', board)).toBeUndefined();
    expect(requestProblem('cut-over', {}, as('owner'), 'sp', board)?.status).toBe(400);
  });

  it('has Koala answer an owner or a client on the owner\'s instance, and a collaborator only from their own', () => {
    const ask = { conversationId: 'channel-x', at: '1', content: 'hi' };
    expect(requestProblem('ask-koala', ask, as('client'), 'sp', board)).toBeUndefined();
    expect(requestProblem('ask-koala', ask, as('owner'), 'sp', board)).toBeUndefined();
    expect(requestProblem('ask-koala', ask, as('collaborator'), 'sp', board)).toEqual({ status: 403, why: 'Koala answers a collaborator from their own instance, once it is linked to this project' });
    expect(requestProblem('ask-koala', ask, withSharedRole(asPerson('member'), 'elsewhere', 'owner'), 'sp', board)?.status).toBe(403);
    expect(requestProblem('ask-koala', { ...ask, conversationId: 'private' }, as('client'), 'sp', board)?.status).toBe(400);
  });

  it('shows every member how the work runs, and keeps moving and removing files to owners and collaborators', () => {
    expect(relayProblem('turns', as('client'), 'sp')).toBeUndefined();
    expect(relayProblem('files.read', as('client'), 'sp')).toBeUndefined();
    expect(relayProblem('files.upload', as('client'), 'sp')).toBeUndefined();
    expect(relayProblem('files.remove', as('client'), 'sp')).toBe('only an owner or a collaborator can move or remove files');
    expect(relayProblem('files.move', as('client'), 'sp')).toBe('only an owner or a collaborator can move or remove files');
    expect(relayProblem('files.move', as('collaborator'), 'sp')).toBeUndefined();
    expect(relayProblem('files.remove', as('owner'), 'sp')).toBeUndefined();
  });
});
