import { principalOf, type BearerSignIn, type ClaimSettings, type Database } from '../../platform/index.js';
import type { RunGrant } from '../../engine/index.js';
import type { RootSignIn } from './RootSignIn.js';

export interface RunBearersDeps {
  tokens: Pick<RootSignIn, 'checkRunToken'>;
  grantOfRun: (runId: string) => Promise<Pick<RunGrant, 'state' | 'personId'> | undefined>;
  accounts: Pick<Database['accounts'], 'getUserById'>;
  claims: ClaimSettings;
}

export class RunBearers {
  constructor(private readonly deps: RunBearersDeps) {}

  async signIn(token: string): Promise<BearerSignIn> {
    const checked = await this.deps.tokens.checkRunToken(token);
    if (typeof checked === 'string') return { refused: checked };
    const grant = await this.deps.grantOfRun(checked.runId);
    if (!grant) return { refused: `run ${checked.runId} is not known here` };
    if (grant.state === 'ended') return { refused: `run ${checked.runId} has ended` };
    if (grant.state === 'revoked') return { refused: `run ${checked.runId}'s access was taken away` };
    if (checked.space) {
      const space = await this.deps.accounts.getUserById(checked.space);
      if (space?.space?.person !== checked.personId || (grant.personId !== checked.personId && grant.personId !== space.id)) {
        return { refused: `${checked.space} is not a check space of this run's person` };
      }
      return { user: space, principal: principalOf(space, this.deps.claims) };
    }
    if (grant.personId !== checked.personId) return { refused: `run ${checked.runId} is not this person's` };
    const user = await this.deps.accounts.getUserById(checked.personId);
    if (!user) return { refused: `${checked.personId} has never signed in here` };
    return { user, principal: { kind: 'person', id: checked.personId, claims: checked.claims } };
  }
}
