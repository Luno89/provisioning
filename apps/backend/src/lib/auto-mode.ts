export interface AutoModeSettings {
  ownerId: string;
  agents: string[];
  updatedAt: string;
}

export interface RunAsking {
  agentSlug: string;
  settings?: Pick<AutoModeSettings, 'agents'> | undefined;
  tree?: { autoMode?: boolean | undefined } | undefined;
}

export function runsUnasked({ agentSlug, settings, tree }: RunAsking): boolean {
  return tree?.autoMode === true || (settings?.agents ?? []).includes(agentSlug);
}

export function withAgent(settings: AutoModeSettings | undefined, ownerId: string, agentSlug: string, on: boolean, at: string): AutoModeSettings {
  const others = (settings?.agents ?? []).filter((slug) => slug !== agentSlug);
  return { ownerId, agents: on ? [...others, agentSlug].sort() : others, updatedAt: at };
}

export function switchedOn(raw: unknown): boolean | string {
  const on = (raw as { on?: unknown } | undefined)?.on;
  return typeof on === 'boolean' ? on : 'say "on": true or false';
}
