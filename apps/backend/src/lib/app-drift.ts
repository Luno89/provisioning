import type { InventoryItem } from './release-compare.js';

export const ADOPT_FEATURE = 'Customizations from the live app';

export const itemRef = (item: Pick<InventoryItem, 'kind' | 'key'>): string => `${item.kind}/${item.key}`;

export function parseRef(ref: string): { kind: string; key: string } | undefined {
  const at = ref.indexOf('/');
  return at > 0 && at < ref.length - 1 ? { kind: ref.slice(0, at), key: ref.slice(at + 1) } : undefined;
}

export const KIND_LABELS: Readonly<Record<string, string>> = {
  field: 'field', model: 'model', view: 'view', 'edited-view': 'edited view', 'server-action': 'server action',
  automation: 'automation', report: 'report', 'email-template': 'email template',
};

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

export function driftText(project: string, module: string, items: readonly InventoryItem[]): string {
  if (!items.length) return `${project}'s live app holds nothing made or changed in the app that is not in git.`;
  return [
    `${project}'s live app holds ${plural(items.length, 'thing')} made or changed in the app that ${items.length === 1 ? 'is' : 'are'} not in git. Bringing them in puts them in addons/${module}, exactly as they are, and every later release keeps them:`,
    ...items.map((item) => `- ${item.name.replace(/,$/, '')} (${KIND_LABELS[item.kind] ?? item.kind}; ref ${itemRef(item)})`),
  ].join('\n');
}

export function adoptionStory(items: readonly InventoryItem[], module: string): Record<string, unknown> {
  const refs = items.map(itemRef);
  const count = plural(items.length, 'customization');
  return {
    key: 'adopt',
    title: `Bring ${count} made in the app into git`,
    body: `addons/${module} holds what was made or changed in the live app, exactly as it is there, and installs cleanly`,
    brief: [
      `The live app holds ${count} that git does not: ${items.map((item) => item.name.replace(/,$/, '')).join('; ')}.`,
      `export_customizations writes them into addons/${module} exactly as they are in the live app, with adopt.json telling the release to take the live records over rather than make them again. Do not change those files: they are exact copies.`,
      `Then check the module installs with odoo-check, and commit.`,
    ].join('\n\n'),
    tasks: [{
      key: 'export',
      title: `Export ${count} into ${module} and check they install`,
      description: `Call export_customizations with refs ${JSON.stringify(refs)}. Then run odoo-check on ${module} and commit addons/${module}.`,
      role: 'All of it.',
      doneMeans: `addons/${module} holds the exported files unchanged and odoo-check passes on it`,
    }],
  };
}
