
export function isGeneratedName(name: string | undefined): boolean {
  const trimmed = name?.trim();
  if (!trimmed) return true;
  return /^koala-request-[0-9a-f]{6,}$/i.test(trimmed);
}

export function toServiceSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return slug || 'service';
}

export interface NameSources {
  declared?: string | undefined;
  treeName?: string | undefined;
  projectName?: string | undefined;
  deploymentName: string;
}

export function serviceNameFor(sources: NameSources): string {
  const candidates = [sources.declared, sources.treeName, sources.projectName];
  for (const candidate of candidates) {
    if (candidate && !isGeneratedName(candidate)) return toServiceSlug(candidate);
  }
  return toServiceSlug(sources.deploymentName);
}

export const SERVICE_NAME_GUIDANCE = [
  'If this work produces a service other agents will call, give it a short `serviceName` —',
  'lowercase, one or two words, no version, e.g. `weather` or `github-api`. It becomes the prefix',
  'on every tool the service exposes, so a long or generic one makes the tools hard to tell apart.',
].join(' ');

export function usableServiceName(declared: unknown): string | undefined {
  if (typeof declared !== 'string') return undefined;
  const trimmed = declared.trim();
  if (!trimmed || trimmed.length > 40) return undefined;
  if (trimmed.split(/\s+/).length > 3) return undefined;
  if (isGeneratedName(trimmed)) return undefined;
  return trimmed;
}
