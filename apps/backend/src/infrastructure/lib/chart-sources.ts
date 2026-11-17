export const chartRepositoryFor = (pinned: string, sources: string | undefined): string =>
  sources === undefined ? pinned : `${sources.replace(/\/+$/, '')}/${pinned.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;

export const helmArgsFor = (args: readonly string[], sources: string | undefined): string[] =>
  args.map((arg, at) => (at > 0 && args[at - 1] === '--repo' ? chartRepositoryFor(arg, sources) : arg));
