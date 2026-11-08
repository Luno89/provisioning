import path from 'path';
import { fileURLToPath } from 'url';
import { listAt, textAt } from '../../platform/index.js';
import { ignore } from '@koala/engine-core/failures';
import { assessWorkload } from '../lib/workload-health.js';

export type Kubectl = (args: string[]) => Promise<string>;

export type GpuVendor = 'nvidia' | 'amd';

const PLUGINS = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../'), 'k8s', 'gpu-device-plugin');

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

export async function verifyGpuRuntimeSchedulable(kubectl: Kubectl, vendor: GpuVendor): Promise<void> {
  try {
    await kubectl(['get', 'runtimeclass', vendor]);
  } catch {
    throw new Error(
      `GPU RuntimeClass "${vendor}" is not installed on this cluster. It should be applied automatically ` +
      `alongside the device plugin (installGpuDevicePlugin) — check ` +
      `k8s/gpu-device-plugin/${vendor}-runtimeclass.yaml was applied.`
    );
  }

  const probeName = `gpu-runtime-probe-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  try {
    await kubectl([
      'run', probeName,
      '--image=registry.k8s.io/pause:3.9',
      '--restart=Never',
      `--overrides={"spec":{"runtimeClassName":"${vendor}"}}`,
    ]);

    for (;;) {
      await pause(1500);
      const eventsRaw = await kubectl(['get', 'events', '--field-selector', `involvedObject.name=${probeName}`, '-o', 'json']);
      const events = listAt(JSON.parse(eventsRaw) as unknown, 'items');
      const runtimeFailure = events.find((e) =>
        textAt(e, 'reason') === 'FailedCreatePodSandBox' && /no runtime for/i.test(textAt(e, 'message') ?? ''));
      if (runtimeFailure) {
        throw new Error(
          `GPU RuntimeClass "${vendor}" exists in Kubernetes, but the underlying container runtime isn't ` +
          `wired up — any pod requesting a GPU will sit in ContainerCreating forever. This means ` +
          `nvidia-container-toolkit is missing or k3s hasn't been restarted since it was installed ` +
          `(k3s only detects it at its own startup). Fix: sudo bash scripts/setup-gpu.sh, then ` +
          `sudo systemctl restart <your k3s service>. Raw kubelet error: ${textAt(runtimeFailure, 'message') ?? ''}`
        );
      }

      const podRaw = await kubectl(['get', 'pod', probeName, '--ignore-not-found', '-o', 'json']);
      if (!podRaw.trim()) throw new Error(`The "${vendor}" GPU runtime probe pod ${probeName} is gone before it ran`);
      const pod: unknown = JSON.parse(podRaw);
      const phase = textAt(pod, 'status', 'phase');
      if (phase === 'Running' || phase === 'Succeeded') return;
      const health = assessWorkload({ items: [pod] });
      if (health.health === 'unhealthy') throw new Error(`The "${vendor}" GPU runtime probe cannot start: ${health.reason}`);
    }
  } finally {
    await kubectl(['delete', 'pod', probeName, '--ignore-not-found', '--wait=false']).catch((err: unknown) => {
      console.warn(`[gpu-runtime] the GPU runtime probe pod ${probeName} could not be removed and is left running: ${(err as Error).message}`);
    });
  }
}

export async function installGpuDevicePlugin(kubectl: Kubectl, vendor: GpuVendor): Promise<void> {
  const manifestPath = path.join(PLUGINS, `${vendor}.yaml`);
  const dsName = vendor === 'nvidia' ? 'nvidia-device-plugin-daemonset' : 'amdgpu-device-plugin-daemonset';
  const dsLabel = vendor === 'nvidia' ? 'name=nvidia-device-plugin-ds' : 'name=amdgpu-dp-ds';

  if (vendor === 'nvidia') {
    try {
      await kubectl(['apply', '-f', path.join(PLUGINS, 'nvidia-runtimeclass.yaml')]);
    } catch (err) {
      console.warn(`[gpu-runtime] Failed to apply nvidia RuntimeClass: ${(err as Error).message}`);
    }
  }

  try {
    await kubectl(['get', 'daemonset', dsName, '-n', 'kube-system']);
    console.log(`[gpu-runtime] GPU device plugin (${vendor}) DaemonSet already exists, skipping install.`);
  } catch {
    console.log(`[gpu-runtime] Installing GPU device plugin (${vendor}) DaemonSet...`);
    const applied = await kubectl(['apply', '-f', manifestPath]);
    console.log(`[gpu-runtime] GPU device plugin (${vendor}) applied: ${applied.trim()}`);
  }

  console.log(`[gpu-runtime] Waiting for GPU device plugin (${vendor}) pod to become ready...`);
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const podsJson = await kubectl(['get', 'pods', '-n', 'kube-system', '-l', dsLabel, '-o', 'json']);
      const pods = listAt(JSON.parse(podsJson) as unknown, 'items');
      const hasReadyPod = pods.some((pod) =>
        textAt(pod, 'status', 'phase') === 'Running' &&
        listAt(pod, 'status', 'conditions').some((c) => textAt(c, 'type') === 'Ready' && textAt(c, 'status') === 'True')
      );
      if (hasReadyPod) {
        ready = true;
        break;
      }
    } catch (failure) {
      ignore('a read of the plugin pods that fails is tried again on the next pass')(failure);
    }
    await pause(2000);
  }

  if (!ready) {
    throw new Error(
      `GPU device plugin (${vendor}) DaemonSet failed to become ready within 60s. ` +
      `Check plugin pod logs: kubectl get pods -n kube-system -l ${dsLabel} ` +
      `and kubectl logs -n kube-system -l ${dsLabel}`
    );
  }

  console.log(`[gpu-runtime] GPU device plugin (${vendor}) is ready.`);
}
