/**
 * What a service Koala built should be CALLED, as opposed to what Kubernetes calls it.
 *
 * ── WHY THESE ARE DIFFERENT NAMES ──
 * A deployment is named after the request that produced it — `koala-request-42784df9` — and so is
 * its project and its repository. That is a fine identifier and a terrible name. It became the
 * prefix on every tool the service exposes, so a model choosing between services saw
 * `koala-request-42784df9__get-forecast` and had nothing to reason about: the one piece of the name
 * that should say what the thing IS is a hex id.
 *
 * The tree already holds the good name. Somebody — usually the planner — called it "Weather API
 * MCP" when the work started, and nothing has ever used that for anything but a heading.
 *
 * ── WHY IT IS RESOLVED AND NOT RENAMED ──
 * Renaming the deployment would mean renaming its namespace, its Service and its DNS, which orphans
 * everything currently running. The identifier stays; only the NAME the model sees is resolved. A
 * service can be renamed later without touching a single Kubernetes object.
 */

/**
 * Identifiers that are ids wearing a name's clothes.
 *
 * `koala-request-<hex>` is what the platform generates when nobody chose anything. Matching it
 * explicitly means a real name is always preferred, however far down the chain it sits.
 */
export function isGeneratedName(name: string | undefined): boolean {
  // Trimmed first: whitespace is not a name, and `'  '` is truthy.
  const trimmed = name?.trim();
  if (!trimmed) return true;
  return /^koala-request-[0-9a-f]{6,}$/i.test(trimmed);
}

/** A name reduced to something that can be a tool prefix and a DNS label. */
export function toServiceSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    // Long prefixes eat the tool name in a list the model has to scan.
    .slice(0, 32)
    .replace(/-+$/, '');
  return slug || 'service';
}

export interface NameSources {
  /** What the planner declared this service should be called, if it said. */
  declared?: string | undefined;
  /** The tree that owns the work — the name a person actually chose. */
  treeName?: string | undefined;
  projectName?: string | undefined;
  /** Last resort. Always present, always an id. */
  deploymentName: string;
}

/**
 * The name a service is offered under.
 *
 * Ordered by how deliberate each source is. The planner declaring a name is the most deliberate
 * thing available; a generated id is the least, and is only reached when everything above it is
 * also generated.
 */
export function serviceNameFor(sources: NameSources): string {
  const candidates = [sources.declared, sources.treeName, sources.projectName];
  for (const candidate of candidates) {
    if (candidate && !isGeneratedName(candidate)) return toServiceSlug(candidate);
  }
  // Everything above was generated or missing. The id is a bad name and an honest one.
  return toServiceSlug(sources.deploymentName);
}

/**
 * What the planner is asked, when it is deciding to build a service.
 *
 * Deliberately short and deliberately about the SERVICE rather than the project: "the GitHub MCP
 * server project" is a fine project name and a bad tool prefix, and the thing that ends up in front
 * of a model on every turn is the second one.
 */
export const SERVICE_NAME_GUIDANCE = [
  'If this work produces a service other agents will call, give it a short `serviceName` —',
  'lowercase, one or two words, no version, e.g. `weather` or `github-api`. It becomes the prefix',
  'on every tool the service exposes, so a long or generic one makes the tools hard to tell apart.',
].join(' ');

/**
 * Whether a declared name is worth accepting.
 *
 * The planner is asked for a short name and will sometimes answer with a sentence. Rejecting that
 * is better than prefixing every tool with it — and falling back to the tree name loses nothing.
 */
export function usableServiceName(declared: unknown): string | undefined {
  if (typeof declared !== 'string') return undefined;
  const trimmed = declared.trim();
  if (!trimmed || trimmed.length > 40) return undefined;
  // More than three words is a description, not a name.
  if (trimmed.split(/\s+/).length > 3) return undefined;
  if (isGeneratedName(trimmed)) return undefined;
  return trimmed;
}
