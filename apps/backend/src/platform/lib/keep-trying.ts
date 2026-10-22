export function keepTrying(what: string, attempt: () => Promise<void>, log: (message: string) => void, everyMs = 10_000): Promise<boolean> {
  const once = async (): Promise<boolean> => {
    try {
      await attempt();
      return true;
    } catch (err) {
      log(`${what}: ${(err as Error).message}; trying again in ${Math.round(everyMs / 1000)} s`);
      setTimeout(() => { void once(); }, everyMs);
      return false;
    }
  };
  return once();
}
