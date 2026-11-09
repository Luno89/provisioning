export interface Core {
  lookup: (id: string) => string;
}

export function makeCore(): Core {
  const lookup = (id: string) => id.toUpperCase();
  return { lookup };
}
