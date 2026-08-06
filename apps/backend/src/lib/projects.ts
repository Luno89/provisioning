/**
 * Projects — a user's git repositories, and the Gitea account that owns them.
 *
 * ── WHY EACH USER GETS THEIR OWN GITEA ACCOUNT ──
 * Everything else on this platform runs as the single `provisioning-bot` admin. That is fine for a
 * build Job the backend controls, and unacceptable for a sandbox: pushing requires a credential
 * INSIDE the container, and an admin token there would give a model — acting on a repo it was told
 * to read — write access to every tenant's code.
 *
 * A per-user account makes the credential's reach equal to the user's own work, which is the same
 * boundary `ownerId` already draws everywhere else. Measured against Gitea 1.27, a token scoped to
 * `write:repository` alone cannot create repositories (needs `write:user`), cannot enumerate the
 * account (needs `read:user`), and returns "Repository not found" for another user's repo. Repo
 * creation stays in the backend, under admin credentials, where the sandbox cannot reach it.
 */

// The project record itself is `ProjectMetadata` in lib/types.ts, which already carries
// `giteaOwner`, `giteaRepo` and `ownerId`. This module adds only what per-user Gitea accounts
// need — a second Project type would have split repository ownership across two records.

/**
 * The Gitea account standing in for a platform user.
 *
 * The password exists only so the backend can mint tokens as that user — Gitea's token endpoint
 * takes the user's own basic auth, not an admin override. It is encrypted at rest with the same
 * master key as cloud credentials and never leaves the backend.
 */
export interface GiteaAccount {
  ownerId: string;
  username: string;
  /** AES-256-GCM, via lib/crypto. Never returned by any route. */
  passwordEnc: string;
  createdAt: string;
}

/** Gitea caps usernames at 40 characters and allows alphanumerics, dash, underscore and dot. */
export const MAX_GITEA_USERNAME = 40;

/**
 * Derives the Gitea username for a platform user.
 *
 * Deterministic, so the account can always be found again without storing a mapping first, and
 * prefixed so a platform-created account is never mistaken for one someone made by hand. Dashes are
 * stripped from the id because a 36-character UUID plus a prefix exceeds Gitea's limit.
 */
export function giteaUsernameFor(ownerId: string): string {
  const slug = ownerId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  if (!slug) throw new Error('Cannot derive a Gitea username from an empty owner id');
  return `koala-${slug}`.slice(0, MAX_GITEA_USERNAME);
}

/**
 * Sanitises a user-supplied project name into a legal repository name.
 *
 * Gitea rejects a great deal — spaces, slashes, leading dots — and the failure arrives as an opaque
 * 422 several calls later, so it is cheaper to normalise up front than to explain it afterwards.
 */
export function sanitiseRepoName(name: string): string {
  const cleaned = (name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 100);
  if (!cleaned) throw new Error(`"${name}" contains nothing usable as a repository name`);
  return cleaned;
}

/** Ceiling per user. A model that can register projects can register them in a loop. */
export const MAX_PROJECTS_PER_USER = 50;
