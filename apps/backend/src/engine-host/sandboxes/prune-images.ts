import type { WantedImage } from './warm-images.js';

/** A workspace image the registry holds, named by the fingerprint that produced it. */
export interface RegistryImageTag {
  fingerprint: string;
  createdAt: string;
}

export interface PruneReport {
  removed: string[];
  kept: string[];
  tooNew: string[];
  failed: { fingerprint: string; detail: string }[];
}

export interface ImagePrunerOptions {
  tags(): Promise<RegistryImageTag[]>;
  wanted(): Promise<WantedImage[]>;
  remove(fingerprint: string): Promise<void>;
  /**
   * How long an image nothing wants is kept anyway. A build publishes its tag before anything plans
   * it again, and a person may be mid-edit, so the youngest images are left alone.
   */
  graceMs?: number;
  now?(): number;
}

export const PRUNE_GRACE_MS = 24 * 60 * 60_000;

/** The sweep waits for the boot warm to publish what is wanted, then runs once a day. */
export const PRUNE_FIRST_DELAY_MS = 5 * 60_000;
export const PRUNE_INTERVAL_MS = 24 * 60 * 60_000;

export interface ImagePruner {
  prune(): Promise<PruneReport>;
}

/**
 * Lets go of the workspace images nothing would run.
 *
 * The fingerprints are derived from what the agents need, so an image is never lost, only rebuilt:
 * the next run that wants it computes the same name and builds it again. That is why this can afford
 * to be a sweep rather than a careful accounting — the cost of a mistake is thirty seconds of kaniko.
 */
export function createImagePruner(options: ImagePrunerOptions): ImagePruner {
  const graceMs = options.graceMs ?? PRUNE_GRACE_MS;
  const now = options.now ?? (() => Date.now());

  return {
    async prune(): Promise<PruneReport> {
      const [tags, wanted] = await Promise.all([options.tags(), options.wanted()]);
      const keep = new Set(wanted.map((entry) => entry.fingerprint));
      const report: PruneReport = { removed: [], kept: [], tooNew: [], failed: [] };

      for (const tag of tags) {
        if (keep.has(tag.fingerprint)) {
          report.kept.push(tag.fingerprint);
          continue;
        }

        // An unreadable date counts as new: keeping an image is cheap, deleting the wrong one costs a build.
        const age = now() - Date.parse(tag.createdAt);
        if (!(age >= graceMs)) {
          report.tooNew.push(tag.fingerprint);
          continue;
        }

        try {
          await options.remove(tag.fingerprint);
          report.removed.push(tag.fingerprint);
        } catch (err) {
          report.failed.push({ fingerprint: tag.fingerprint, detail: (err as Error).message });
        }
      }

      return report;
    },
  };
}
