export const PLATFORM_SERVICES = ["egress", "searxng", "crawl4ai", "quickwit", "qdrant", "tei", "gitea", "verdaccio", "infisical"] as const;
export type PlatformServiceName = typeof PLATFORM_SERVICES[number];

export interface PlatformInputs {
  existing: ReadonlySet<string>;
  koalaNamespace: string;
  pool: boolean;
  stamp: string;
}

export function platformSettingsFrom(env: Record<string, string | undefined>): { name: PlatformServiceName; inputs: PlatformInputs } {
  const problems: string[] = [];
  const setting = (name: string, why: string): string | undefined => {
    const value = env[name]?.trim();
    if (!value) problems.push(`${name} is not set: ${why}`);
    return value || undefined;
  };
  const name = setting("PLATFORM_SERVICE", "it names the platform service this stack applies");
  if (name && !(PLATFORM_SERVICES as readonly string[]).includes(name)) problems.push(`PLATFORM_SERVICE is ${name}; the platform services are ${PLATFORM_SERVICES.join(", ")}`);
  const listed = setting("PLATFORM_EXISTING", "it lists what is already on the cluster, which the stack takes over rather than makes");
  let existing: string[] | undefined;
  if (listed) {
    try {
      const parsed: unknown = JSON.parse(listed);
      if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) throw new Error("not a list of strings");
      existing = parsed;
    } catch {
      problems.push("PLATFORM_EXISTING is not a JSON list of what is already on the cluster");
    }
  }
  const koalaNamespace = setting("KOALA_NAMESPACE", "it is the namespace of the Koala the services answer");
  const pool = setting("POOL", "it says whether the services run on Koala's servers or a person's machine");
  if (pool && pool !== "true" && pool !== "false") problems.push(`POOL is ${pool}; it is true on Koala's servers and false on a person's machine`);
  const stamp = setting("SECRET_STAMP", "it changes when the service's Secret does, so its pods restart onto it");
  if (problems.length > 0 || !name || !existing || !koalaNamespace || !pool || !stamp) throw new Error(`a platform stack cannot be made:\n${problems.join("\n")}`);
  return { name: name as PlatformServiceName, inputs: { existing: new Set(existing), koalaNamespace, pool: pool === "true", stamp } };
}
