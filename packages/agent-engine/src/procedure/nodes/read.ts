type Settings = Readonly<Record<string, unknown>>;

export const textOf = (settings: Settings, name: string, fallback = ''): string => {
  const value = settings[name];
  return typeof value === 'string' ? value : fallback;
};

export const numberOf = (settings: Settings, name: string, fallback: number): number => {
  const value = settings[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

export const flagOf = (settings: Settings, name: string, fallback: boolean): boolean => {
  const value = settings[name];
  return typeof value === 'boolean' ? value : fallback;
};

export const textsOf = (settings: Settings, name: string): string[] => {
  const value = settings[name];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
};

export const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();
