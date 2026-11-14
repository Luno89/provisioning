export interface Kind<T> {
  name: string;
  list: () => Promise<readonly T[]>;
  idOf: (item: T) => string;
  stampOf: (item: T) => string | undefined;
}

export interface MadeHere {
  before(): Promise<void>;
  made(id: string): void;
  madeIds(): string[];
  removeMade(remove: (id: string) => Promise<void>): Promise<void>;
  untouched(): Promise<void>;
}

export function madeHere<T>(kind: Kind<T>): MadeHere {
  let there: Map<string, string | undefined> | undefined;
  const made = new Set<string>();
  const read = async () => new Map((await kind.list()).map((item) => [kind.idOf(item), kind.stampOf(item)]));
  return {
    async before() {
      there = await read();
    },
    made(id) {
      if (!there) throw new Error(`${kind.name}: read what was there before recording what the suite made`);
      if (there.has(id)) throw new Error(`${kind.name} ${id} was there before this suite began, so it is not the suite's to remove`);
      made.add(id);
    },
    madeIds() {
      return [...made];
    },
    async removeMade(remove) {
      if (!there) throw new Error(`${kind.name}: read what was there before removing anything`);
      for (const id of made) await remove(id);
    },
    async untouched() {
      if (!there) throw new Error(`${kind.name}: read what was there before checking it was left alone`);
      const now = await read();
      const gone = [...there.keys()].filter((id) => !now.has(id));
      const changed = [...there].filter(([id, stamp]) => now.has(id) && now.get(id) !== stamp).map(([id]) => id);
      if (!gone.length && !changed.length) return;
      const said = [...(gone.length ? [`${gone.join(', ')} ${gone.length === 1 ? 'is' : 'are'} gone`] : []), ...(changed.length ? [`${changed.join(', ')} changed`] : [])];
      throw new Error(`of the owner's ${kind.name}, ${said.join(' and ')} while the suite ran`);
    },
  };
}
