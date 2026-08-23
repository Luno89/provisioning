/**
 * What the OAuth callback is telling us, read from the query string.
 *
 * Pure and outside the component so it can be called from a lazy initialiser without reading
 * external state during render — and so the three failure codes can be tested without mounting
 * anything. See rule R18 in CLAUDE.md.
 */
export function driveNoticeFrom(search: string): { kind: 'success' | 'error'; message: string } | null {
  const params = new URLSearchParams(search);
  if (params.get('driveConnected')) {
    return { kind: 'success', message: 'Google Drive connected.' };
  }
  const code = params.get('driveError');
  if (!code) return null;
  const message = code === 'missing_client_id'
    ? 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set in apps/backend/.env.'
    : code === 'no_refresh_token'
      ? "Google didn't return a refresh token — revoke this app's access at myaccount.google.com/permissions and try connecting again."
      : `Connection failed: ${decodeURIComponent(code)}`;
  return { kind: 'error', message };
}
