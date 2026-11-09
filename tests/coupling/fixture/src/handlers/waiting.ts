export interface Held {
  resolve: (value: string) => void;
}

const held = new Map<string, Held>();

export function wait(id: string): Promise<string> {
  return new Promise((resolve) => { held.set(id, { resolve }); });
}

export function answer(id: string, value: string): void {
  held.get(id)?.resolve(value);
}
