import { describe } from 'vitest';
import { clientSessionsContract } from './client-sessions-contract.js';
import { standInClientSessions } from './client-sessions-stand-in.js';

describe('the stand-in for root\'s sign-in, held to the same contract as the real one', () => {
  clientSessionsContract(async () => {
    const standIn = standInClientSessions();
    return { sessions: standIn.sessions, signIn: async () => standIn.signIn({ userId: 'owner-1', email: 'owner@koala.test', claims: [{ role: 'person' }, { role: 'instance-owner' }] }) };
  });
});
