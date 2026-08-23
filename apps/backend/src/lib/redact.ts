/**
 * Keeping credentials out of what gets STORED.
 *
 * ── THE GAP ──
 * A trace holds every command's stdout, and `LeafEvidence` now holds diffs and file contents. Both
 * go to Mongo verbatim. `maskSecret` has existed for a while and is used only by CredentialService
 * for API responses, so nothing stood between a token an agent echoed and a database row.
 *
 * ── HOW BAD, HONESTLY ──
 * The Gitea checkout credential — the one most likely to appear, because it lives in a file under
 * /work and the agent can read any file it likes — is REVOKED at teardown (see
 * ExecuteLeafActivity's `finally`). A copy of it in a stored trace is a dead string. What is not
 * revoked: the model endpoint's API key, passwords a spec generated, and anything the agent found
 * in the repository it was given. Those persist, and a stored trace outlives the run by design.
 *
 * So this is not "a leak was happening"; it is that nothing was preventing one, and the cost of
 * preventing it is a substring replace.
 *
 * ── KNOWN VALUES FIRST, PATTERNS SECOND ──
 * Pattern-matching for secrets is guesswork: the shapes change, and a regex loose enough to catch
 * an unknown key is loose enough to shred a diff. The caller usually KNOWS the secrets in play — it
 * minted the checkout credential and resolved the API key — so those are replaced exactly, and
 * patterns only cover what could not be known in advance.
 *
 * ── AND WHY IT IS DELIBERATELY CONSERVATIVE ──
 * A destroyed diagnostic is its own failure. These traces exist to answer "why did this fail", and
 * a redactor that eats git SHAs, base64 payloads or long identifiers would make the record useless
 * in exchange for safety it did not provide. Every pattern below is anchored on a recognisable
 * prefix or structure, and nothing is redacted for being merely long.
 */

/** What replaces a secret. Distinctive so a reader knows redaction happened rather than corruption. */
export const REDACTED = '[redacted]';

/**
 * Below this, a "known secret" is too short to replace safely.
 *
 * A caller passing a short or empty value — an unset env var read as `''`, a username, a two-letter
 * token — would otherwise blank every occurrence of that fragment in the text. The failure mode is
 * a trace redacted into confetti, which is worse than the leak.
 */
const MIN_KNOWN_LENGTH = 8;

/**
 * Shapes worth catching without being told about them.
 *
 * Each is anchored on a prefix or a structure that does not occur by accident. Deliberately absent:
 * "any long random-looking string", which matches commit SHAs, base64 blobs and UUIDs.
 */
const PATTERNS: { name: string; re: RegExp; replace: (m: string, ...rest: string[]) => string }[] = [
  {
    // https://user:token@host — how a git remote carries a credential.
    name: 'url-credentials',
    re: /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
    replace: (_m, scheme) => `${scheme}${REDACTED}@`,
  },
  {
    name: 'private-key-block',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => `-----BEGIN PRIVATE KEY-----${REDACTED}-----END PRIVATE KEY-----`,
  },
  {
    // Vendor-prefixed tokens. The prefixes are the point: they do not appear by chance.
    name: 'prefixed-token',
    re: /\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|glpat-[A-Za-z0-9_-]{16,})\b/g,
    replace: () => REDACTED,
  },
  {
    // A JWT: three base64url segments separated by dots, starting with the `{"` header.
    name: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: () => REDACTED,
  },
  {
    /**
     * `password=…`, `token: …`, `api_key="…"` — matched on the ASSIGNMENT, not the value's shape.
     *
     * The leading prefix is not decoration: `\b` does not match inside `MONGO_PASSWORD`, because an
     * underscore is a word character, so the anchored version missed every environment variable —
     * which is the form these actually appear in. Caught by its own test.
     */
    name: 'assigned-secret',
    re: /([A-Za-z0-9_.-]*(?:api[_-]?key|secret|password|passwd|token|bearer)\s*[=:]\s*)(["']?)([^\s"'&,;]{8,})\2/gi,
    replace: (_m, lead, quote) => `${lead}${quote}${REDACTED}${quote}`,
  },
];

/**
 * Removes credentials from text that is about to be persisted.
 *
 * `known` is exact values the caller holds — the checkout URL, its token, the model API key. They
 * are replaced first and unconditionally, because an exact match cannot be wrong.
 */
export function redactSecrets(text: string, known: readonly (string | undefined)[] = []): string {
  if (!text) return text;
  let out = text;

  for (const secret of known) {
    if (!secret || secret.length < MIN_KNOWN_LENGTH) continue;
    out = out.split(secret).join(REDACTED);
    /**
     * The same value as it appears inside a URL.
     *
     * A credential embedded in a clone URL is percent-encoded, so the literal never matches — which
     * is exactly the case most likely to occur, since that is the form the agent was handed.
     */
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = out.split(encoded).join(REDACTED);
  }

  for (const { re, replace } of PATTERNS) {
    out = out.replace(re, replace as (substring: string, ...args: unknown[]) => string);
  }

  return out;
}

/**
 * Applies redaction across a whole object's strings, in place of the caller doing it field by field.
 *
 * Used at storage boundaries where the shape is a record rather than a blob — an agent step has
 * reasoning, content, tool arguments and results, and missing one of them defeats the exercise.
 * Depth-limited: these are data records, not arbitrary graphs, and an unbounded walk over something
 * cyclic would hang the write it is protecting.
 */
export function redactDeep<T>(value: T, known: readonly (string | undefined)[] = [], depth = 0): T {
  if (depth > 6) return value;
  if (typeof value === 'string') return redactSecrets(value, known) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, known, depth + 1)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, known, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}
