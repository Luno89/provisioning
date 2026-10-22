import type { TreeType } from '../types/grove'

export function versionLabel(tree: { type?: string | undefined; version?: string | undefined }, types: readonly Pick<TreeType, 'id' | 'versions'>[]): string | undefined {
  const versions = types.find((type) => type.id === tree.type)?.versions
  return versions && tree.version ? `${versions.of} ${tree.version}` : undefined
}
