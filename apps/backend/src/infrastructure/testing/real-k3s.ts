import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { k3sStep, localCommands, removeSteps, runSteps, waiting, waitUntil, type Step, type Waiting } from '@koala/provision';
import { containerProvider, containersOn, type ContainerContext, memoryReporter, throwawayLabel } from '@koala/provision/testing';
import type { ServiceAccount } from '../lib/cluster-places.js';
import { ClusterCommandFailed, clusterAccessOfKubeconfig } from '../services/ClusterAccess.js';
import { ensureImageCaches, IMAGE_CACHES, imageCacheContainer } from './image-caches.js';

export const K3S_TEST_IMAGE = 'rancher/k3s:v1.36.4-k3s1@sha256:edad48e12bf81c3a09ac1c05c0c0ffaaa22145980b989d6fae84543a76b83657';

declare module 'vitest' {
  export interface ProvidedContext {
    k3s: { admin: string; account: ServiceAccount };
  }
}

export interface RealK3s {
  admin: string;
  account: ServiceAccount;
  folder: string;
  stop(): Promise<void>;
}

const quiet = { line: () => undefined };

async function mirrorsThroughCaches(ctx: ContainerContext): Promise<string> {
  const containers = containersOn(ctx.commands);
  await ensureImageCaches(containers);
  const lines = ['mirrors:'];
  for (const cache of IMAGE_CACHES) {
    const address = await containers.addressOf(imageCacheContainer(cache.registry));
    if (!address) throw new Error(`the image cache for ${cache.registry} has no address on Docker's network`);
    lines.push(`  "${cache.registry}":`, '    endpoint:', `      - "http://${address}:5000"`);
  }
  const file = join(mkdtempSync(join(tmpdir(), 'koala-k3s-registries-')), 'registries.yaml');
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

type Kubectl = (args: readonly string[]) => Promise<string>;

const answersAt = async (kubectl: Kubectl, args: readonly string[]): Promise<boolean> => {
  try {
    await kubectl(args);
    return true;
  } catch (failure) {
    if (failure instanceof ClusterCommandFailed && failure.result.code === 1) return false;
    throw failure;
  }
};

function addOnsStep(name: string, kubectl: Kubectl, ended: () => Promise<string | undefined>): Step<ContainerContext> {
  const applied = async (ctx: ContainerContext): Promise<true | Waiting> => {
    const manifests = (await containersOn(ctx.commands).exec(name, ['ls', '/var/lib/rancher/k3s/server/manifests'])).split('\n').filter((file) => file.endsWith('.yaml'));
    if (manifests.includes('traefik.yaml')) return waiting('traefik.yaml is still among its manifests');
    const events = (await kubectl(['get', 'events', '-n', 'kube-system', '--field-selector', 'involvedObject.kind=Addon,reason=AppliedManifest', '-o', 'jsonpath={range .items[*]}{.involvedObject.name}{"\\n"}{end}'])).split('\n');
    const unapplied = manifests.filter((file) => !events.includes(file.replace(/\.yaml$/, '')));
    return unapplied.length === 0 ? true : waiting(`${unapplied.join(', ')} not applied yet`);
  };
  return {
    id: 'k3s-add-ons',
    title: 'k3s\'s own add-ons applied and available, and Koala\'s account on it',
    check: async () => (await answersAt(kubectl, ['get', 'serviceaccount', 'koala', '-n', 'default']) ? { done: true } : { done: false, why: 'Koala has no account on it yet' }),
    async apply(ctx) {
      await waitUntil('k3s to make its default service account', async () => (await answersAt(kubectl, ['get', 'serviceaccount', 'default', '-n', 'default']) ? true : waiting('no default service account yet')), ended);
      await waitUntil('k3s to apply its own add-ons', () => applied(ctx), ended);
      await kubectl(['wait', '--for=condition=Available', 'deployment', '--all', '-n', 'kube-system', '--timeout=720h']);
      await kubectl(['create', 'serviceaccount', 'koala', '-n', 'default']);
      await kubectl(['create', 'clusterrolebinding', 'koala', '--clusterrole=cluster-admin', '--serviceaccount=default:koala']);
    },
  };
}

export async function startK3s(): Promise<RealK3s> {
  const ctx: ContainerContext = { commands: localCommands(process.env) };
  const name = `koala-k3s-test-${randomUUID().slice(0, 8)}`;
  const registries = await mirrorsThroughCaches(ctx);
  const folder = mkdtempSync(join(tmpdir(), 'koala-k3s-'));
  const adminFile = join(folder, 'admin.yaml');
  const container = containerProvider({ name, image: K3S_TEST_IMAGE, run: [...throwawayLabel(), '--privileged', '-p', '127.0.0.1::6443', '-v', `${registries}:/etc/rancher/k3s/registries.yaml:ro`, '--entrypoint', '/bin/sh'], command: ['-c', 'mount --make-rshared / && exec /bin/k3s server --disable=traefik,servicelb,metrics-server --tls-san 127.0.0.1'], publish: [6443] });
  let admin = '';
  const kubeconfig = async (): Promise<string> => {
    if (admin) return adminFile;
    const written = join(folder, 'k3s.yaml');
    await containersOn(ctx.commands).copyOut(name, '/etc/rancher/k3s/k3s.yaml', written);
    admin = readFileSync(written, 'utf8').replace('https://127.0.0.1:6443', `https://127.0.0.1:${container.published(6443)}`);
    writeFileSync(adminFile, admin, { mode: 0o600 });
    return adminFile;
  };
  const kubectl: Kubectl = async (args) => {
    await kubeconfig();
    const { access, target } = clusterAccessOfKubeconfig(admin, name);
    return access.kubectl(target, args);
  };
  const steps: Step<ContainerContext>[] = [k3sStep(container, kubectl, () => 0), addOnsStep(name, kubectl, () => container.ended(ctx, quiet))];
  const reporter = memoryReporter();
  try {
    await runSteps(steps, ctx, reporter);
    const port = String(container.published(6443));
    const token = (await kubectl(['create', 'token', 'koala', '-n', 'default', '--duration=1h'])).trim();
    const ca = Buffer.from(/certificate-authority-data: (\S+)/.exec(admin)![1]!, 'base64').toString('utf8');
    const account: ServiceAccount = { host: '127.0.0.1', port, caFile: join(folder, 'ca.crt'), tokenFile: join(folder, 'token') };
    writeFileSync(account.caFile, ca, { mode: 0o600 });
    writeFileSync(account.tokenFile, token, { mode: 0o600 });
    return { admin, account, folder, stop: () => removeSteps(steps, ctx, reporter) };
  } catch (failure) {
    await removeSteps(steps, ctx, reporter);
    throw failure;
  }
}
