import { serviceStep, type Provider, type ServiceContext } from './service.js';
import type { Step, StepState } from './steps.js';

export type Kubectl = (args: readonly string[]) => Promise<string>;

const READY = '{.items[0].status.conditions[?(@.type=="Ready")].status} {.items[0].status.conditions[?(@.type=="Ready")].lastTransitionTime}';

export const readySince = (answer: string, since: number): boolean => {
  const [status, at] = answer.trim().split(' ');
  return status === 'True' && Boolean(at) && Date.parse(at!) >= since;
};

export function k3sAnswers(kubectl: Kubectl, since: () => number): () => Promise<StepState> {
  return async () => {
    let node: string;
    let dns: string;
    try {
      node = await kubectl(['get', 'nodes', '-o', `jsonpath=${READY}`]);
      dns = await kubectl(['-n', 'kube-system', 'get', 'pod', '-l', 'k8s-app=kube-dns', '-o', `jsonpath=${READY}`]);
    } catch (err) {
      return { done: false, why: `its API refuses kubectl while it starts: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!readySince(node, since())) return { done: false, why: 'its node has not turned Ready since it started' };
    if (!readySince(dns, since())) return { done: false, why: 'its DNS has not turned Ready since it started' };
    return { done: true };
  };
}

export function k3sStep<Context extends ServiceContext>(provider: Provider<Context>, kubectl: Kubectl, since: () => number): Step<Context> {
  return serviceStep({ id: 'k3s', title: 'k3s, its node and DNS ready,', provider, answers: k3sAnswers(kubectl, since) });
}
