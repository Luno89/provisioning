export type Wire<T> = T extends Date
  ? string
  : T extends (...args: never[]) => unknown
    ? never
    : T extends readonly [unknown, ...unknown[]]
      ? { -readonly [Index in keyof T]: Wire<T[Index]> }
      : T extends readonly (infer Item)[]
        ? Wire<Item>[]
        : T extends object
          ? { [Key in keyof T]: Wire<Exclude<T[Key], undefined>> }
          : T
