export const UPGRADE_WORDS = {
  running: (tag: string) => `Running ${tag}`,
  upgrading: (from: string, to: string) => `Upgrading from ${from} to ${to}`,
  upgraded: (to: string) => `Upgraded to ${to}`,
  rolledBack: (to: string, from: string) => `The upgrade to ${to} failed, so it was rolled back to ${from}`,
  notRolledBack: (to: string, from: string) => `The upgrade to ${to} failed, and rolling back to ${from} did not finish`,
  wrongChart: (to: string) => `The chart root sent for ${to} is not the one it released (its sha256 differs), so nothing was changed`,
  notADigest: (digest: string, to: string) => `Root named ${digest} as the image of ${to}, which is not a digest, so nothing was changed`,
  belowData: (to: string, needs: number) => `Root offered ${to}, which cannot run this instance's data (data version ${needs}), so nothing was changed`,
  keptForData: (to: string, from: string, needs: number) => `The upgrade to ${to} failed, and it is not rolled back to ${from}, which cannot run the data ${to} may have moved forward (data version ${needs})`,
} as const;

export const withWhy = (words: string, why: string): string => `${words}: ${why}`.slice(0, 500);
