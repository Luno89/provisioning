/**
 * The harness configuration as a file you can commit.
 *
 * ── WHY EXPORT RATHER THAN STORE IN GIT ──
 * The obvious move is to put settings in a repo and read them from there. That is the wrong trade:
 * it puts a repo fetch in the critical path of every leaf run and every experiment variant, so
 * "Gitea is unreachable" becomes "the harness cannot run" — a strictly worse failure than the ones
 * it fixes. Merge semantics on `temperature: 0.3` are worse than useless too.
 *
 * And most of it is already versioned. The agent prompt is `buildAgentPrompt` in sandbox-tools.ts;
 * it gets diffs, review and rollback through the normal code path. What is NOT in git is the
 * promoted profile and the benchmark suites — runtime state, and the thing worth carrying between
 * machines.
 *
 * So this makes git AVAILABLE without making it load-bearing: a plain, diffable JSON document you
 * can commit, review, share or restore, while the running system keeps reading from the database.
 * If a settings repo is ever wanted, this snapshot is already the artifact to put in it.
 *
 * ── RESULTS ARE NOT EXPORTED ──
 * A suite definition is portable; its results are not. Numbers produced by one model on one machine
 * mean nothing restored somewhere else, and shipping them would invite exactly that comparison.
 * The export carries the QUESTION, and the importing side answers it for itself.
 */
import type { Experiment, ExperimentTask, ExperimentVariant, HarnessProfile, Overrides } from '@koala/harness-types';
import { experimentTasks } from './experiments.js';

/** Bumped when the shape changes in a way an older importer would misread. */
export const CONFIG_EXPORT_VERSION = 1;

export interface ExportedSuite {
  name: string;
  tasks: Omit<ExperimentTask, 'id'>[];
  variants: ExperimentVariant[];
  repeats: number;
}

export interface ConfigExport {
  version: number;
  exportedAt: string;
  /** The adopted defaults, with the evidence that earned them. */
  profile?: { overrides: Overrides; from?: HarnessProfile['from'] };
  /** Benchmark definitions — the questions, not the answers. */
  suites: ExportedSuite[];
}

export function buildConfigExport(
  experiments: Experiment[],
  profile: HarnessProfile | null,
  now = new Date().toISOString(),
): ConfigExport {
  return {
    version: CONFIG_EXPORT_VERSION,
    exportedAt: now,
    ...(profile && Object.keys(profile.overrides ?? {}).length
      ? { profile: { overrides: profile.overrides, ...(profile.from ? { from: profile.from } : {}) } }
      : {}),
    suites: experiments.map((e) => ({
      name: e.name,
      // Ids are positional and assigned on create, so they are deliberately dropped — an imported
      // suite gets its own, and carrying them would imply a continuity that does not exist.
      tasks: experimentTasks(e).map(({ id: _id, ...task }) => task),
      variants: e.variants,
      repeats: e.repeats,
    })),
  };
}

export interface ImportedConfig {
  suites: ExportedSuite[];
  profile?: { overrides: Overrides; from?: HarnessProfile['from'] };
  /** Anything skipped, and why. Reported rather than dropped — a half-read file is a trap. */
  rejected: string[];
}

/**
 * Reads an exported document back.
 *
 * Defensive in the same way the proposal readers are: anything it cannot confidently read is
 * skipped and named, because a suite that imports as three tasks when the file had five is worse
 * than one that refuses.
 */
export function parseConfigExport(raw: unknown): ImportedConfig | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'Not a configuration export.' };
  const doc = raw as Partial<ConfigExport>;

  if (typeof doc.version !== 'number') return { error: 'Missing a version — is this a config export?' };
  if (doc.version > CONFIG_EXPORT_VERSION) {
    // Forward-incompatible rather than best-effort: silently ignoring fields a newer writer
    // considered essential is how an import looks successful and is not.
    return { error: `This file is version ${doc.version}; this harness reads up to ${CONFIG_EXPORT_VERSION}.` };
  }

  const rejected: string[] = [];
  const suites: ExportedSuite[] = [];

  for (const [i, raw2] of (Array.isArray(doc.suites) ? doc.suites : []).entries()) {
    const s = raw2 as Partial<ExportedSuite>;
    const name = String(s?.name ?? '').trim();
    if (!name) { rejected.push(`suite ${i + 1}: no name`); continue; }

    const tasks = (Array.isArray(s.tasks) ? s.tasks : [])
      .map((t: any) => ({
        name: String(t?.name ?? '').trim(),
        prompt: String(t?.prompt ?? ''),
        verifyCommand: String(t?.verifyCommand ?? '').trim(),
        // Without these a restored suite is not the same suite: a task whose seed did not travel
        // asks the agent to work on files that are no longer there.
        ...(Array.isArray(t?.seed) && t.seed.length ? { seed: t.seed } : {}),
        ...(Array.isArray(t?.solution) && t.solution.length ? { solution: t.solution } : {}),
        ...(t?.language ? { language: t.language } : {}),
      }))
      .filter((t) => t.name && t.prompt && t.verifyCommand);

    if (!tasks.length) { rejected.push(`${name}: no usable tasks`); continue; }
    if (!Array.isArray(s.variants) || !s.variants.length) { rejected.push(`${name}: no variants`); continue; }

    suites.push({
      name,
      tasks,
      variants: s.variants as ExperimentVariant[],
      repeats: Math.max(1, Number(s.repeats) || 1),
    });
  }

  return {
    suites,
    ...(doc.profile?.overrides ? { profile: doc.profile } : {}),
    rejected,
  };
}
