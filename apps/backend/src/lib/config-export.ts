import type { Experiment, ExperimentTask, ExperimentVariant, HarnessProfile, Overrides } from '@koala/harness-types';
import { experimentTasks } from './experiments.js';

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
  profile?: { packId: string; from?: HarnessProfile['from'] | undefined };
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
    ...(profile?.packId
      ? { profile: { packId: profile.packId, ...(profile.from ? { from: profile.from } : {}) } }
      : {}),
    suites: experiments.map((e) => ({
      name: e.name,
      tasks: experimentTasks(e).map(({ id: _id, ...task }) => task),
      variants: e.variants,
      repeats: e.repeats,
    })),
  };
}

export interface ImportedConfig {
  suites: ExportedSuite[];
  profile?: { packId: string; from?: HarnessProfile['from'] | undefined };
  rejected: string[];
}

export function parseConfigExport(raw: unknown): ImportedConfig | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'Not a configuration export.' };
  const doc = raw as Partial<ConfigExport>;

  if (typeof doc.version !== 'number') return { error: 'Missing a version — is this a config export?' };
  if (doc.version > CONFIG_EXPORT_VERSION) {
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
    ...(doc.profile?.packId ? { profile: doc.profile } : {}),
    rejected,
  };
}
