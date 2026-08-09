/**
 * Reading a plan back before anyone commits to it, and keeping a replacement wired up.
 *
 * ── WHY ──
 * Counted from a real end-to-end run: six times a person had to say something a user would have no
 * way of knowing to say. Two of them were about the plan itself, and both are mechanically
 * detectable:
 *
 *   · Five leaves were proposed with no dependencies at all, so they would have started at once in
 *     separate sandboxes and the one that assembled the others would have found nothing to import.
 *     Spotting that required knowing `dependsOn` exists.
 *   · A leaf was withdrawn and replaced, and the leaf that depended on it kept pointing at the dead
 *     one. Spotting that required knowing how dependency resolution treats a missing id.
 *
 * A plan that will not work should say so before it runs, not after it has spent an afternoon.
 */
import { dependentsOf, type Leaf } from './leaves.js';

export interface PlanWarning {
  /** Stable enough to test against and to suppress individually later. */
  code: 'no-ordering' | 'unchecked' | 'dangling-dependency' | 'duplicate-title';
  text: string;
}

/**
 * Leaves that will not be checked by anything.
 *
 * `expects` covers work with no tests; a test suite covers code. A leaf with neither is one whose
 * only evidence of success is the agent saying so — which is precisely what everything else here
 * exists to stop relying on.
 */
function unchecked(leaves: Leaf[]): Leaf[] {
  return leaves.filter((l) => !l.expects?.length && !l.verifyCommand?.trim());
}

export function reviewPlan(leaves: Leaf[]): PlanWarning[] {
  const live = leaves.filter((l) => l.status === 'proposed' || l.status === 'pending');
  if (live.length === 0) return [];
  const warnings: PlanWarning[] = [];

  /**
   * Several leaves and not one ordering constraint.
   *
   * Not a warning for a single leaf, which cannot depend on anything, and not for a plan where SOME
   * ordering exists — a genuine fan-out of independent work is a normal shape and flagging it would
   * train everyone to ignore this.
   */
  if (live.length > 1 && live.every((l) => !l.dependsOn?.length)) {
    warnings.push({
      code: 'no-ordering',
      text: `All ${live.length} of these will start at the same time, each in its own empty sandbox. `
        + 'If any of them builds on another\'s output, it will find nothing there.',
    });
  }

  const blind = unchecked(live);
  if (blind.length) {
    warnings.push({
      code: 'unchecked',
      text: `Nothing will check ${blind.length === live.length ? 'any of these' : `${blind.length} of these`}`
        + ` — ${blind.slice(0, 3).map((l) => `"${l.title}"`).join(', ')}`
        + `${blind.length > 3 ? ', …' : ''}. Without \`expects\` or tests, success means the agent said so.`,
    });
  }

  /**
   * A dependency naming a leaf that no longer exists.
   *
   * Deliberately loud, because the runtime is deliberately quiet: `dependenciesMet` treats a
   * missing id as MET, on the grounds that stranding the dependent forever is worse. That is the
   * right call and it means a withdrawn dependency silently becomes no dependency at all — the
   * ordering is gone and nothing at runtime will ever mention it.
   */
  const known = new Set(leaves.map((l) => l.id));
  for (const leaf of live) {
    const missing = (leaf.dependsOn ?? []).filter((d) => !known.has(d));
    if (missing.length) {
      warnings.push({
        code: 'dangling-dependency',
        text: `"${leaf.title}" waits on ${missing.length} leaf/leaves that no longer exist, so it will `
          + 'start without them and the ordering is lost. Point it at the replacement.',
      });
    }
  }

  /**
   * Two live leaves sharing a title.
   *
   * Dependencies are declared by title, and the resolver keeps the last match — so which one a
   * dependency means is decided by database order rather than by anything anyone intended.
   */
  const byTitle = new Map<string, number>();
  for (const l of live) {
    const key = l.title.trim().toLowerCase();
    byTitle.set(key, (byTitle.get(key) ?? 0) + 1);
  }
  for (const [title, count] of byTitle) {
    if (count > 1) {
      warnings.push({
        code: 'duplicate-title',
        text: `${count} leaves are called "${title}". Dependencies are declared by title, so anything `
          + 'depending on that name could attach to either. Rename one.',
      });
    }
  }

  return warnings;
}

/** Renders warnings for the conversation, or nothing when the plan looks sound. */
export function planNotice(warnings: PlanWarning[]): string | undefined {
  if (!warnings.length) return undefined;
  return [
    warnings.length === 1 ? '**One thing to check before accepting:**' : '**Some things to check before accepting:**',
    '',
    ...warnings.map((w) => `- ${w.text}`),
  ].join('\n');
}

/**
 * Moves every dependency on one leaf across to another.
 *
 * Returns only the leaves that actually change, so a caller writes the few rows that moved rather
 * than rewriting the board.
 */
export function rewireDependents(leaves: Leaf[], fromId: string, toId: string): Leaf[] {
  return dependentsOf(fromId, leaves).map((l) => ({
    ...l,
    // Deduplicated: a leaf that already depended on BOTH would otherwise end up naming the
    // replacement twice, and be reported as waiting on two things that are one thing.
    dependsOn: [...new Set((l.dependsOn ?? []).map((d) => (d === fromId ? toId : d)))],
  }));
}
