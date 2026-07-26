/**
 * Keep in sync with packages/cdktf-infra/constructs/tabbyapi.ts's own `folderName` computation —
 * duplicated rather than shared because CDKTF and the backend are separate npm workspaces.
 * DownloadModelActivity (backend) has to compute the exact same on-disk folder name the pod's
 * hostPath mount and its own startup script (CDKTF construct) will look for, or a pre-download
 * lands somewhere the pod never checks.
 */
export function computeModelFolderName(modelRepo: string, revision?: string): string {
  return `${modelRepo}${revision ? `--${revision}` : ''}`
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
