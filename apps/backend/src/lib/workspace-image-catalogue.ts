import type { EgressRule, WorkspaceImageSpec, WorkspaceLanguage } from './workspace-image-seeds.js';
import { DEFAULT_WORKSPACE_LANGUAGE } from './workspace-image-seeds.js';

export function isWorkspaceLanguage(
  rows: readonly WorkspaceImageSpec[],
  value: unknown,
): value is WorkspaceLanguage {
  return typeof value === 'string' && rows.some((r) => r.id === value);
}

export function imageForLanguage(rows: readonly WorkspaceImageSpec[], language?: string): string {
  const asked = rows.find((r) => r.id === language);
  const fallback = rows.find((r) => r.id === DEFAULT_WORKSPACE_LANGUAGE) ?? rows[0];
  return (asked ?? fallback)?.image ?? '';
}

/**
 * The image asked for, unless the work needs something it does not have — then the first image that
 * does. A leaf that asks for `base` and needs git gets an image with git rather than failing in the
 * sandbox on the first checkout.
 */
export function capableImage(
  rows: readonly WorkspaceImageSpec[],
  language: string | undefined,
  requires: readonly string[] = [],
): string {
  const asked = imageForLanguage(rows, language);
  if (!requires.length) return asked;

  const entry = rows.find((r) => r.image === asked);
  const missing = requires.filter((tool) => entry?.absent.includes(tool));
  if (!missing.length) return asked;

  return rows.find((r) => requires.every((tool) => !r.absent.includes(tool)))?.image ?? asked;
}

export function packageAccess(
  rows: readonly WorkspaceImageSpec[],
  language: string | undefined,
): { env: { name: string; value: string }[]; egress: EgressRule[] } {
  const key = isWorkspaceLanguage(rows, language) ? language : DEFAULT_WORKSPACE_LANGUAGE;
  const entry = rows.find((r) => r.id === key)?.packageAccess ?? { env: [], egress: [] };
  return {
    env: entry.env.map((e) => ({ ...e })),
    egress: entry.egress.map((r) => ({ ...r, ...(r.ports ? { ports: [...r.ports] } : {}) })),
  };
}

export function detailsForImage(
  rows: readonly WorkspaceImageSpec[],
  image: string,
): WorkspaceImageSpec | undefined {
  return rows.find((r) => r.image === image);
}
