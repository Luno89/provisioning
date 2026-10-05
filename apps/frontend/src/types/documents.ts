/**
 * ── DUPLICATED, KNOWINGLY ──
 * Mirrors `OpenedDocument` in apps/backend/src/services/DocumentService.ts, which wins.
 */
export interface OpenedDocument {
  workspace: string;
  path: string;
  owner: string;
  repo: string;
  ref: string;
  content: string;
}

export interface DocumentAddress {
  workspace: string;
  path: string;
  at?: string | undefined;
}
