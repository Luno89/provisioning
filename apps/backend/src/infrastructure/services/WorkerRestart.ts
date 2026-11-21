import type { ClusterAccess, Target } from './ClusterAccess.js';

export interface WorkerRestartDeps {
  access: Pick<ClusterAccess, 'kubectl' | 'follow'>;
  target: () => Target;
  namespace: string;
}

export type Restarted = 'restarted' | 'not-here';

type Heard = 'there' | 'gone';

export class WorkerRestart {
  constructor(private readonly deps: WorkerRestartDeps) {}

  async restart(pod: string): Promise<Restarted> {
    const { access, namespace } = this.deps;
    const target = this.deps.target();
    let said = '';
    const heard: Record<Heard, () => void> = { there: () => undefined, gone: () => undefined };
    const there = new Promise<'there'>((done) => { heard.there = () => done('there'); });
    const gone = new Promise<'gone'>((done) => { heard.gone = () => done('gone'); });
    const watch = await access.follow(target, ['get', 'pod', pod, '-n', namespace, '--watch', '--output-watch-events', '-o', 'json'], (chunk) => {
      said += chunk;
      if (/"type":\s*"(ADDED|MODIFIED)"/.test(said)) heard.there();
      if (/"type":\s*"DELETED"/.test(said)) heard.gone();
    });
    const ended = watch.ended.then((result) => ({ ended: result }));
    const first = await Promise.race([there, ended]);
    if (first !== 'there') {
      if (/NotFound|not found/i.test(first.ended.stderr)) return 'not-here';
      throw new Error(`the watch on pod ${pod} ended before it said where the pod stands: ${first.ended.stderr.trim() || `exit ${first.ended.code}`}`);
    }
    await access.kubectl(target, ['delete', 'pod', pod, '-n', namespace, '--wait=false']);
    const last = await Promise.race([gone, ended]);
    watch.stop();
    if (last !== 'gone') throw new Error(`the watch on pod ${pod} ended before Kubernetes said the pod was gone: ${last.ended.stderr.trim() || `exit ${last.ended.code}`}`);
    return 'restarted';
  }
}
