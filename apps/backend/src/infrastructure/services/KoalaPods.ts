import type { ClusterAccess, Target } from './ClusterAccess.js';
import type { Followed } from '../../platform/index.js';

export interface KoalaPodsDeps {
  access: Pick<ClusterAccess, 'kubectl' | 'follow'>;
  target: () => Target;
  namespace: string;
}

const EVENT = /^(ADDED|MODIFIED|DELETED|BOOKMARK|ERROR) (\S+)$/;

export class KoalaPods {
  constructor(private readonly deps: KoalaPodsDeps) {}

  async live(): Promise<string[]> {
    const { access, namespace } = this.deps;
    const listed = await access.kubectl(this.deps.target(), ['get', 'pods', '-n', namespace, '-o', 'jsonpath={.items[*].metadata.name}']);
    return listed.split(/\s+/).filter(Boolean);
  }

  async whenGone(onGone: (pod: string) => void): Promise<Followed> {
    const { access, namespace } = this.deps;
    let partial = '';
    return access.follow(this.deps.target(), ['get', 'pods', '-n', namespace, '--watch', '--output-watch-events', '-o', 'jsonpath={.type} {.object.metadata.name}{"\\n"}'], (chunk) => {
      const lines = (partial + chunk).split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) {
        const event = EVENT.exec(line.trim());
        if (event?.[1] === 'DELETED' && event[2]) onGone(event[2]);
      }
    });
  }
}
