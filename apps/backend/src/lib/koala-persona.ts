import type { Persona } from './personas.js';

/**
 * Koala — the one you talk to when you have not decided what you are building yet.
 *
 * ── WHY THIS EXISTS ──
 * Every persona before it was written for a job: the Framer splits questions, the Builder writes
 * code, the Reviewer reads it. There was nobody to just talk to, so the chat persona selector
 * defaulted to "No persona" — and the honest answer to "who am I talking to" was nobody, with a
 * default prompt and no services.
 *
 * ── CHAT ONLY, AND WHY THAT IS NOT A LIMITATION ──
 * A persona carries the whole sandbox: language, egress, repository, time budget. A generic one has
 * no sensible answer to any of those — "anything" is not a toolchain — so a leaf assigned to Koala
 * would run in an environment nobody chose. It proposes work and hands it to personas that were
 * written for it, which is what the specialised ones are FOR.
 *
 * `acceptLeaf` refuses a leaf assigned to it for exactly this reason, at acceptance rather than ten
 * minutes later in a sandbox.
 */

/** The name is the identity: everything that looks Koala up does it by this. */
export const KOALA_NAME = 'Koala';

export const KOALA_PROMPT = [
  'You are Koala. You help think through what someone wants to build, and you are good company',
  'when they have not worked that out yet.',
  '',
  'You are talking, not building. There is no repository here and no sandbox — when work needs',
  'doing, you propose a PROJECT with propose_tree and it gets built in the Grove by personas',
  'written for it. Propose one when the work is clear enough to name, not for every passing idea,',
  'and never propose one just to have proposed something.',
  '',
  'Services:',
  /**
   * The catalogue rides in the prompt as names only — see buildKoalaPrompt. Telling the model how
   * to get the rest is the whole mechanism: without this it either assumes it has the tools (and
   * hallucinates calls) or assumes it has none (and refuses work it could do).
   */
  '- The services listed below are deployed and real, but their tools are NOT loaded yet.',
  '- Call enable_mcp_server with a name to hook one up. Its tools become available immediately,',
  '  in this same reply — you can enable and then call in one turn.',
  '- Enable one when you actually need it. Say what you enabled and why, briefly.',
  '- Call list_mcp_servers if you need to know what a service does before enabling it.',
  '',
  'You can also look at what already exists — trees, their projects, and how work is going — so',
  '"how is X going" is a question you can answer rather than guess at.',
  '',
  'Infrastructure:',
  /**
   * Added after Koala planned MongoDB caching for a platform with no MongoDB. Stated as a refusal
   * rather than a suggestion, because the failure is agreeing to something impossible — a model
   * told to "check first" still plans around what it finds missing unless told not to.
   */
  '- Before proposing anything that needs a database, a cache, storage or search, call',
  '  list_infrastructure. It reports what is running and everything this platform can deploy.',
  '- If what is needed appears in NEITHER list, it does not exist here and cannot be built. Say so',
  '  plainly and offer what is actually available instead. Do not design around it, and do not',
  '  assume a service exists because it is common.',
].join('\n');

/**
 * The seed, deliberately minimal.
 *
 * No language, no repo, no egress: those are execution settings and this persona never executes.
 * `mcp` stays empty because Koala's services are enabled per session, not granted up front — the
 * whole point of the lazy mechanism.
 */
export function koalaSeed(): Omit<Persona, 'id' | 'ownerId' | 'createdAt' | 'updatedAt'> {
  return {
    name: KOALA_NAME,
    description: 'General chat. Talks things through and proposes projects to build.',
    systemPrompt: KOALA_PROMPT,
    scope: {},
  } as Omit<Persona, 'id' | 'ownerId' | 'createdAt' | 'updatedAt'>;
}

/**
 * Whether a persona is one that can actually run a leaf.
 *
 * Koala is the only one that cannot, and it is identified by NAME rather than a flag on the record
 * so that a user editing their Koala — which they are allowed to do — cannot accidentally turn it
 * into something the executor will try to run in an environment it has no settings for.
 */
export function isChatOnly(persona: Pick<Persona, 'name'> | null | undefined): boolean {
  return (persona?.name ?? '').trim().toLowerCase() === KOALA_NAME.toLowerCase();
}

/**
 * The system prompt for a turn, with the catalogue of what could be hooked up.
 *
 * Names and one-line descriptions only. A full tool schema for every deployed service would ride on
 * every message of every conversation; a name is about ten tokens and is all the model needs to
 * know the thing exists and can be asked for.
 *
 * Servers already enabled this session are marked rather than omitted — a model that cannot see a
 * service it is holding tools for will enable it again, and spend a round doing it.
 */
export function buildKoalaPrompt(
  base: string,
  servers: readonly { name: string; description?: string | undefined }[],
  enabled: readonly string[],
): string {
  if (!servers.length) {
    return `${base}\n\nNo services are deployed yet. Propose a project to build one.`;
  }
  const lines = servers.map((s) => {
    const mark = enabled.includes(s.name) ? ' — ENABLED, its tools are already available' : '';
    return `- ${s.name}${s.description ? `: ${s.description}` : ''}${mark}`;
  });
  return `${base}\n\nServices you can hook up:\n${lines.join('\n')}`;
}
