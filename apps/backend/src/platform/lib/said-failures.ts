import type { DependencyId } from './dependencies.js';

export const saidFailures = (process: string, say: (line: string) => void): { failed(dependency: DependencyId, err: unknown): unknown } => ({
  failed(dependency, err) {
    say(`${dependency} did not answer ${process}: ${(err as Error).message}`);
    return err;
  },
});
