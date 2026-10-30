import { devOnly } from './dependency-rule.js';
export type ComponentKind = 'npm' | 'binary' | 'image' | 'chart' | 'action' | 'unpinned';

export interface InventoryComponent {
  ref: string;
  name: string;
  version?: string | undefined;
  kind: ComponentKind;
  in?: string | undefined;
  dev: boolean;
  where?: string | undefined;
  ecosystem?: string | undefined;
  osvName?: string | undefined;
  github?: string | undefined;
  floating: boolean;
}

interface BomComponent {
  'bom-ref'?: unknown;
  scope?: unknown;
  name?: unknown;
  version?: unknown;
  properties?: { name?: unknown; value?: unknown }[];
}

const KINDS: readonly ComponentKind[] = ['npm', 'binary', 'image', 'chart', 'action', 'unpinned'];

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

export function inventoryComponents(bom: unknown): InventoryComponent[] {
  const components = (bom as { components?: unknown } | undefined)?.components;
  if (!Array.isArray(components)) return [];
  return (components as BomComponent[]).flatMap((component) => {
    const props = Object.fromEntries((component.properties ?? []).flatMap((entry) => (typeof entry.name === 'string' && typeof entry.value === 'string' ? [[entry.name, entry.value]] : [])));
    const kind = props['koala:kind'] as ComponentKind | undefined;
    const name = text(component.name);
    const ref = text(component['bom-ref']);
    if (!kind || !KINDS.includes(kind) || !name || !ref) return [];
    const version = text(component.version);
    const npm = kind === 'npm';
    return [{
      ref,
      name,
      version,
      kind,
      in: props['koala:in'],
      dev: devOnly({ scope: text(component.scope), dev: props['koala:dev'] === 'true' }),
      where: props['koala:where'],
      ecosystem: npm ? 'npm' : props['koala:osv-ecosystem'],
      osvName: npm ? name : props['koala:osv-name'],
      github: props['koala:github'],
      floating: props['koala:floating'] === 'true',
    }];
  });
}

export const checkedByOsv = (component: InventoryComponent): boolean =>
  Boolean(component.ecosystem && component.osvName && component.version && component.kind !== 'unpinned' && !component.floating);

export const osvVersion = (component: Pick<InventoryComponent, 'ecosystem' | 'version'>): string =>
  component.ecosystem === 'Go' ? (component.version ?? '').replace(/^v/, '') : component.version ?? '';
