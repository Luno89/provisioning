import { dependentsOf, type Leaf } from './leaves.js';

export interface PlanWarning {
  code: 'no-ordering' | 'unchecked' | 'dangling-dependency' | 'duplicate-title' | 'no-acceptance';
  text: string;
}

function unchecked(leaves: Leaf[]): Leaf[] {
  return leaves.filter((l) => !l.expects?.length && !l.verifyCommand?.trim());
}

export function reviewPlan(leaves: Leaf[], acceptanceChecks = 0): PlanWarning[] {
  const live = leaves.filter((l) => l.status === 'proposed' || l.status === 'pending');
  if (live.length === 0) return [];
  const warnings: PlanWarning[] = [];

  if (live.length > 1 && live.every((l) => !l.dependsOn?.length)) {
    warnings.push({
      code: 'no-ordering',
      text: `All ${live.length} of these will start at the same time, each in its own empty sandbox. `
        + 'If any of them builds on another\'s output, it will find nothing there.',
    });
  }

  if (acceptanceChecks === 0) {
    warnings.push({
      code: 'no-acceptance',
      text: 'Nothing will run the finished result. Per-leaf checks prove each piece works; without '
        + 'acceptance checks nothing proves the assembled whole does.',
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

export function planNotice(warnings: PlanWarning[]): string | undefined {
  if (!warnings.length) return undefined;
  return [
    warnings.length === 1 ? '**One thing to check before accepting:**' : '**Some things to check before accepting:**',
    '',
    ...warnings.map((w) => `- ${w.text}`),
  ].join('\n');
}

export function rewireDependents(leaves: Leaf[], fromId: string, toId: string): Leaf[] {
  return dependentsOf(fromId, leaves).map((l) => ({
    ...l,
    dependsOn: [...new Set((l.dependsOn ?? []).map((d) => (d === fromId ? toId : d)))],
  }));
}
