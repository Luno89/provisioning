export type Wire<T> = T extends Date
  ? string
  : T extends (...args: never[]) => unknown
    ? never
    : T extends readonly (infer Item)[]
      ? Wire<Item>[]
      : T extends object
        ? { [Key in keyof T]: Wire<Exclude<T[Key], undefined>> }
        : T
