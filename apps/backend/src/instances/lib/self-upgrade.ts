export const UPGRADE_WORDS = {
  running: (tag: string) => `Running ${tag}`,
  upgrading: (from: string, to: string) => `Upgrading from ${from} to ${to}`,
  upgraded: (to: string) => `Upgraded to ${to}`,
  rolledBack: (to: string, from: string) => `The upgrade to ${to} failed, so it was rolled back to ${from}`,
  notRolledBack: (to: string, from: string) => `The upgrade to ${to} failed, and rolling back to ${from} did not finish`,
  wrongChart: (to: string) => `The chart root sent for ${to} is not the one it released (its sha256 differs), so nothing was changed`,
  notADigest: (digest: string, to: string) => `Root named ${digest} as the image of ${to}, which is not a digest, so nothing was changed`,
} as const;

export const withWhy = (words: string, why: string): string => `${words}: ${why}`.slice(0, 500);

interface Item {
  kind?: string;
  metadata?: { name?: string; creationTimestamp?: string };
  status?: { succeeded?: number };
}

const itemsOf = (listed: unknown): Item[] => ((listed as { items?: Item[] })?.items ?? []).filter((item) => item && typeof item === 'object');
const madeSince = (item: Item, since: number): boolean => Date.parse(item.metadata?.creationTimestamp ?? '') >= Math.floor(since / 1000) * 1000;

export const abandonedJobs = (listed: unknown, since: number): string[] => itemsOf(listed)
  .filter((item) => item.kind === 'Job' && madeSince(item, since) && (item.status?.succeeded ?? 0) === 0)
  .map((item) => item.metadata?.name)
  .filter((name): name is string => name !== undefined);
