/**
 * The fields a caller may set on a new leaf, normalised once.
 *
 * ── WHY THIS IS SHARED ──
 * A leaf is assembled from scratch in two places — the HTTP route and the `propose_leaf` tool — and
 * each one names its fields by hand. Twice now a field was added to the type, wired into one path,
 * and silently dropped by the other: `dependsOn` and then `expects` were both accepted by the API,
 * typechecked, and written to a record without them.
 *
 * An audit of the two paths found a third divergence nobody had hit yet: `language` was settable by
 * the model and not over HTTP, so an API-created leaf always ran in the default Node image no
 * matter what it was for.
 *
 * ── WHAT THIS DOES AND DOES NOT COVER ──
 * The fields whose handling is genuinely identical. Not `dependsOn`, `persona` or `projectId` —
 * the tool resolves those from titles and names because the model cannot know an id it has not been
 * told, while the route takes ids directly. Forcing one shape on both would either make the tool
 * unusable or make the API lie about what it accepts.
 *
 * Everything here is untrusted input: model output on one path, a request body on the other.
 */
import { usablePaths } from './leaf-artifacts.js';
import { usableAcceptance } from './acceptance.js';
import { isLeafColumn, type Leaf } from './leaves.js';

/**
 * Every simple field, in one list.
 *
 * The list is what makes forgetting one visible: a field added to `Leaf` and not to this is a field
 * neither creation path can set, which is a question that comes up while writing it rather than a
 * silent hole discovered on a live run.
 */
export const LEAF_INPUT_FIELDS = [
  'title', 'body', 'column', 'blocking', 'expects', 'mcp', 'verifyCommand',
] as const;

export function normaliseLeafInput(raw: Record<string, unknown>): Partial<Leaf> {
  const out: Partial<Leaf> = {};

  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (title) out.title = title.slice(0, 200);

  const body = typeof raw.body === 'string' ? raw.body.trim() : '';
  if (body) out.body = body.slice(0, 4000);

  // Validated rather than trusted: `column` is untrusted JSON and the union type checks nothing at
  // runtime.
  if (isLeafColumn(raw.column)) out.column = raw.column;

  // Only an explicit `false` turns it off — an absent value must not silently un-block a leaf.
  if (raw.blocking === false) out.blocking = false;


  const expects = usablePaths(Array.isArray(raw.expects) ? raw.expects.map(String) : []);
  if (expects.length) out.expects = expects;

  // Server NAMES, bounded and de-duplicated. Not paths — `usablePaths` would reject them.
  const mcp = Array.isArray(raw.mcp)
    ? [...new Set(raw.mcp.map((m: unknown) => String(m).trim()).filter(Boolean))].slice(0, 8)
    : [];
  if (mcp.length) out.mcp = mcp;

  /**
   * The per-leaf equivalent of the request's acceptance checks.
   *
   * It was read by `ExecuteLeafActivity` and writable by nothing — a field that looked like a
   * feature and could never be set. Held to the same shape rule as an acceptance command, since it
   * is the same kind of thing running in the same kind of place.
   */
  const verify = usableAcceptance(raw.verifyCommand);
  if (verify) out.verifyCommand = verify;

  return out;
}
