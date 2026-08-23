/**
 * Turning a resolved binding into files, wherever they are going.
 *
 * ── WHY THIS IS ITS OWN MODULE ──
 * `binding-resolve.ts` decides WHICH secret may be read and what the binding will be called, and is
 * pure so that decision can be tested exhaustively without a cluster. This is the other half: the
 * act of reading it. It exists separately because there are now two destinations — an app's
 * namespace at deploy time, and a leaf's sandbox namespace at run time — and the decode is the one
 * step where a mistake is silent. A key mapped wrongly produces a Secret full of empty strings, and
 * the failure surfaces much later as an authentication error against a service that is fine.
 *
 * ── AND WHY THE CALLER STILL WRITES ITS OWN SECRET ──
 * The two destinations write differently: a deploy applies a manifest per binding into a namespace
 * Terraform owns, while a sandbox folds them into the single document `WorkspaceService.create`
 * applies so that a partial create stays impossible. Sharing the read and not the write is what
 * keeps both of those properties.
 */
import type { ResolvedBinding } from './binding-resolve.js';

/** Runs kubectl and returns stdout. Injected so this is testable without a cluster. */
export type Kubectl = (args: string[]) => Promise<string>;

/**
 * The credential values a binding declared, decoded.
 *
 * Returns only the keys the binding asked for. A source Secret usually holds more than a consumer
 * needs — a binding is the subset required to connect, not a copy of a service's secrets, and
 * `bindingFiles` enforces the same thing again on the way out.
 *
 * Never throws: a binding that cannot be read yields nothing, and the caller writes a Secret with
 * the address but no credentials. That is a better failure than no sandbox, and the agent can see
 * which files are missing.
 */
export async function readBindingCredentials(
  kubectl: Kubectl,
  binding: Pick<ResolvedBinding, 'source'>,
): Promise<Record<string, string>> {
  // `-o json` rather than jsonpath: one parse, and a missing key is visible rather than an empty
  // string that reads as a present-but-blank password.
  const raw = await kubectl(
    ['get', 'secret', binding.source.secretName, '-n', binding.source.namespace, '-o', 'json'],
  ).catch(() => '');

  const data: Record<string, unknown> = (() => {
    try { return JSON.parse(raw || '{}')?.data ?? {}; } catch { return {}; }
  })();

  const credentials: Record<string, string> = {};
  for (const [bindingKey, sourceKey] of Object.entries(binding.source.keys)) {
    const value = data[sourceKey];
    // Kubernetes stores Secret data base64-encoded.
    if (typeof value === 'string') credentials[bindingKey] = Buffer.from(value, 'base64').toString('utf8');
  }
  return credentials;
}
