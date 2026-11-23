import { OidcClient } from '@koala/engine-core/root-client';
import { keepTrying, reopening, type Reopening } from '../../platform/index.js';
import type { IdentityKeyPair } from '../lib/identity-token.js';
import { publicJwkOf, REGISTRATION_REFUSED, registrationMetadata, SERVICE_SCOPE, type ClientKind } from '../lib/oidc.js';

export interface RootClientSettings {
  kind: ClientKind;
  clientId: string;
  rootUrl: string;
  publicUrl: string;
  owner?: string | undefined;
  keys: IdentityKeyPair;
  registrationCode: string;
  reach?: typeof fetch | undefined;
}

export class RootClient extends OidcClient {
  constructor(
    private readonly settings: RootClientSettings,
    now: () => number = () => Date.now(),
  ) {
    const { kind, clientId, rootUrl, publicUrl, owner, keys, registrationCode, reach } = settings;
    super({
      clientId,
      issuer: `${rootUrl}/oidc`,
      keys,
      registrationCode,
      registration: registrationMetadata({ kind, url: publicUrl, key: publicJwkOf(keys), owner }),
      refused: REGISTRATION_REFUSED,
      scope: SERVICE_SCOPE,
      reach,
    }, now);
  }

  keepRegistering(log: (message: string) => void, again: Reopening = reopening()): void {
    void keepTrying(`root has not registered this ${this.settings.kind} yet`, async () => { await this.register(); }, log, (reason) => this.registrationRefused(reason), again);
  }

  async serviceToken(): Promise<string> {
    await this.registered;
    return this.token();
  }
}
