export function computeModelFolderName(modelRepo: string, revision?: string): string {
  return `${modelRepo}${revision ? `--${revision}` : ''}`
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
