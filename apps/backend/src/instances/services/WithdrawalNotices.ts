import { dataHeldMail, dataHolds, withdrawalMail, withdrawalsHeld } from '../lib/instance-updates.js';
import type { InstancesStore } from '../store.js';

export interface WithdrawalMail {
  toOwner(ownerId: string, message: { subject: string; text: string }): Promise<void>;
}

export class WithdrawalNotices {
  constructor(
    private readonly store: Pick<InstancesStore, 'getInstances' | 'getReleases' | 'withdrawalTold' | 'recordWithdrawalTold'>,
    private readonly mail: WithdrawalMail,
    private readonly current: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async tell(): Promise<number> {
    const releases = await this.store.getReleases();
    const rootRelease = releases.find((release) => release.imageTag === this.current);
    let told = 0;
    for (const held of withdrawalsHeld(await this.store.getInstances(), releases)) {
      if (await this.store.withdrawalTold(held.key)) continue;
      try {
        await this.mail.toOwner(held.ownerId, withdrawalMail(held, rootRelease));
      } catch (err) {
        console.error(`[releases] could not tell the owner of ${held.instanceId} that ${held.release.version} was withdrawn: ${(err as Error).message}`);
        continue;
      }
      await this.store.recordWithdrawalTold(held.key, held.ownerId, this.now().toISOString());
      told += 1;
    }
    for (const held of dataHolds(await this.store.getInstances(), releases, this.current)) {
      const key = `data|${held.key}`;
      if (await this.store.withdrawalTold(key)) continue;
      try {
        await this.mail.toOwner(held.ownerId, dataHeldMail(held));
      } catch (err) {
        console.error(`[releases] could not tell the owner of ${held.instanceId} that it stays on its release for its data: ${(err as Error).message}`);
        continue;
      }
      await this.store.recordWithdrawalTold(key, held.ownerId, this.now().toISOString());
      told += 1;
    }
    return told;
  }
}
