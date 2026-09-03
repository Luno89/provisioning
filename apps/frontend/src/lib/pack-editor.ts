import type { Tunable } from '@koala/harness-types';

export const card = 'bg-[var(--bark-800)] border border-[var(--bark-600)] rounded-xl';

export const describeValue = (v: unknown) => (v === undefined ? 'default' : String(v));

export const errorMessage = (err: unknown): string => {
  const e = err as { response?: { data?: { error?: string } }; message?: string };
  return e?.response?.data?.error ?? e?.message ?? 'Something went wrong.';
};

export function describeTunable(
  t: Tunable,
  live?: { value: unknown; source: 'harness' | 'adopted' } | undefined,
): string {
  const lines: string[] = [t.label];
  if (t.note) lines.push('', t.note);

  const effective = live ? live.value : t.default;
  lines.push('', effective === undefined
    ? 'Currently unset — the engine\'s own default applies.'
    : `Currently ${String(effective)}${live?.source === 'adopted' ? ' (adopted default, not the built-in)' : ''}`);

  if (t.min !== undefined || t.max !== undefined) {
    lines.push(`Range ${t.min ?? '−∞'} to ${t.max ?? '∞'}${t.step ? `, step ${t.step}` : ''}`);
  }
  if (t.engine) lines.push(`Only sent to ${t.engine}; dropped on any other engine.`);
  if (t.placement === 'loop') lines.push('Read by the agent loop — never sent to the model.');

  lines.push(`Set in ${t.source}`);
  return lines.join('\n');
}

/**
 * A knob grid as a pack edit. Mirrors the backend's `editFromKnobs`: each tunable names the pack
 * field it sets, so an editor writes pack values rather than a bag layered over one.
 *
 * ── DUPLICATED, KNOWINGLY ──
 * apps/backend/src/lib/derived-packs.ts owns this. It is repeated here because an editor has to
 * show what it will write before it sends anything, and the paths come from the same `Tunable.path`
 * the backend reads. If the two disagree, the backend wins — it is what actually saves.
 */
export function packEditFromKnobs(
  knobs: Record<string, unknown>,
  tunables: readonly { key: string; path?: string }[],
): Record<string, unknown> {
  const edit: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(knobs)) {
    const path = tunables.find((t) => t.key === key)?.path;
    if (!path || value === undefined) continue;

    const parts = path.split('.');
    let at = edit;
    for (const part of parts.slice(0, -1)) {
      at[part] ??= {};
      at = at[part] as Record<string, unknown>;
    }
    at[parts[parts.length - 1]!] = value;
  }
  return edit;
}

/** Reads a dotted `Tunable.path` out of a pack, so a knob can show what the pack has it set to. */
export const packValueAt = (pack: unknown, path: string | undefined): unknown =>
  (path ? path.split('.').reduce<unknown>(
    (at, key) => (at && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined),
    pack,
  ) : undefined);
