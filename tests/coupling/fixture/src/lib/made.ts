export interface Made {
  start(id: string): Promise<string>;
}

export async function make(): Promise<Made> {
  return { start: async (id) => id.toUpperCase() };
}
