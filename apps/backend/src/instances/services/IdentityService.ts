import type { Database, RoleConfig } from '../../platform/index.js';
import { publicKeyPem } from '../lib/identity-token.js';
import { inService, type InstanceRecord } from '../lib/instances.js';
import { signInWaitingFor, START_PATH } from '../lib/oidc.js';

type Store = Pick<Database, 'instances' | 'accounts'>;

export type GoTo = { url: string } | { waiting: string };

export class IdentityService {
  constructor(
    private readonly role: RoleConfig,
    private readonly store: Store,
  ) {}

  publicKeys(): { kid: string; publicKey: string }[] {
    return this.role.signing ? [{ kid: this.role.signing.kid, publicKey: publicKeyPem(this.role.signing.publicKey) }] : [];
  }

  async instanceOf(ownerId: string): Promise<InstanceRecord | undefined> {
    return (await this.store.instances.getInstances(ownerId)).find((instance) => instance.url && inService(instance));
  }

  async goUrl(user: { id: string; email: string }): Promise<GoTo | undefined> {
    if (!this.role.signing) return undefined;
    const instance = await this.instanceOf(user.id);
    if (!instance) return undefined;
    const waiting = signInWaitingFor(instance);
    return waiting ? { waiting } : { url: `${instance.url.replace(/\/+$/, '')}${START_PATH}` };
  }

  removalUrl(): string | undefined {
    return this.role.instance ? `${this.role.instance.rootUrl}/#/remove-account` : undefined;
  }
}
