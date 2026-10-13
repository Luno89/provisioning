export type ToastKind = 'destroyed' | 'external' | 'info' | 'error';

export interface Toast {
  kind: ToastKind
  label: string
  text: string
}

export const toastOf = (n: { type?: string | undefined; name?: string | undefined; message?: string | undefined; outOfBand?: boolean | undefined }): Toast => {
  if (n.message) return n.type === 'error' ? { kind: 'error', label: 'Error', text: n.message } : { kind: 'info', label: 'Notice', text: n.message };
  if (n.outOfBand) return { kind: 'external', label: 'External Event', text: `${n.name ?? 'A resource'} Deleted Externally` };
  return { kind: 'destroyed', label: 'System Event', text: `${n.name ?? 'A resource'} Destroyed` };
};

export const releaseNotice = (
  seen: Set<string>,
  release: { id: string; state: string; commit: string; reason?: string | undefined },
): { type: 'info' | 'error'; message: string } | undefined => {
  if (release.state !== 'preview' && release.state !== 'failed') return undefined;
  const key = `${release.id}:${release.state}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  return release.state === 'preview'
    ? { type: 'info', message: `A new version (${release.commit.slice(0, 8)}) is ready to preview — open the project's Builds panel to look at it and cut over.` }
    : { type: 'error', message: `A release of ${release.commit.slice(0, 8)} failed: ${release.reason ?? 'no reason given'}` };
};
