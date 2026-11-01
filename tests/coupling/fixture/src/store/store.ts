export interface Store {
  read(id: string): string;
}

export class MemoryStore implements Store {
  read(id: string): string {
    return `stored ${id}`;
  }
}
