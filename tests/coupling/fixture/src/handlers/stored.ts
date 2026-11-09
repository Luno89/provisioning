export interface Settings {
  token: () => Promise<string>;
}

export function settingsFrom(token: (() => Promise<string>) | undefined): Settings | undefined {
  return token ? { token } : undefined;
}

export async function bearer(settings: Settings): Promise<string> {
  return `Bearer ${await settings.token()}`;
}
