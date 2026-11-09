import { reopening, type Reopening } from '@koala/engine-core/reopening';

export function keepTrying(what: string, attempt: () => Promise<void>, log: (message: string) => void, again: Reopening = reopening()): Promise<boolean> {
  const once = async (): Promise<boolean> => {
    try {
      await attempt();
      return true;
    } catch (err) {
      log(`${what}: ${(err as Error).message}; trying again in ${again.seconds} s`);
      again.later(() => { void once(); });
      return false;
    }
  };
  return once();
}
