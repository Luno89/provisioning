import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseAllDocuments } from 'yaml';
import { localCommands, removeSteps, runSteps, serviceStep, type Step } from '@koala/provision';
import { containerProvider, containersOn, type ContainerContext, memoryReporter, throwawayLabel } from '@koala/provision/testing';
import { httpAnswers, type MemoryIndex } from '../../platform/index.js';

const K8S = resolve(import.meta.dirname, '../../../../../k8s');

interface Pinned { image: string; args: string[]; env: Record<string, string>; memoryLimit: string }

interface ManifestContainer { image: string; args?: string[]; env?: { name: string; value?: string }[]; resources: { limits: { memory: string } } }

export function pinnedContainer(piece: 'quickwit' | 'qdrant' | 'tei'): Pinned {
  const documents = parseAllDocuments(readFileSync(resolve(K8S, piece, `${piece}.yaml`), 'utf8')).map((document) => document.toJSON() as { kind?: string; spec?: { template?: { spec?: { containers?: ManifestContainer[] } } } });
  const container = documents.find((document) => document.kind === 'Deployment')?.spec?.template?.spec?.containers?.[0];
  if (!container) throw new Error(`k8s/${piece}/${piece}.yaml has no Deployment container`);
  return {
    image: container.image,
    args: container.args ?? [],
    env: Object.fromEntries((container.env ?? []).flatMap((one) => (one.value === undefined ? [] : [[one.name, one.value]]))),
    memoryLimit: container.resources.limits.memory,
  };
}

const MEMORY_SIZES: Readonly<Record<string, number>> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3 };

export function bytesOf(quantity: string): number {
  const found = /^(\d+)(Ki|Mi|Gi)$/.exec(quantity);
  if (!found) throw new Error(`${quantity} is not a memory size this test reads`);
  return Number(found[1]) * MEMORY_SIZES[found[2]!]!;
}

export interface RealMemoryIndex {
  index: MemoryIndex;
  containers: Record<'quickwit' | 'qdrant' | 'tei', string>;
  memoryInUse(name: string): Promise<number>;
  stop(): Promise<void>;
}

const envArgs = (env: Record<string, string>): string[] => Object.entries(env).flatMap(([name, value]) => ['-e', `${name}=${value}`]);

export async function startMemoryIndex(): Promise<RealMemoryIndex> {
  const run = randomUUID().slice(0, 8);
  const apiKey = randomBytes(18).toString('hex');
  const pinned = { quickwit: pinnedContainer('quickwit'), qdrant: pinnedContainer('qdrant'), tei: pinnedContainer('tei') };
  const quickwit = containerProvider({ name: `koala-quickwit-test-${run}`, image: pinned.quickwit.image, run: [...throwawayLabel(), '-p', '127.0.0.1::7280', ...envArgs(pinned.quickwit.env)], command: pinned.quickwit.args, publish: [7280] });
  const qdrant = containerProvider({ name: `koala-qdrant-test-${run}`, image: pinned.qdrant.image, run: [...throwawayLabel(), '-p', '127.0.0.1::6333', ...envArgs({ ...pinned.qdrant.env, QDRANT__SERVICE__API_KEY: apiKey })], publish: [6333] });
  const tei = containerProvider({ name: `koala-tei-test-${run}`, image: pinned.tei.image, run: [...throwawayLabel(), '-p', '127.0.0.1::80', ...envArgs(pinned.tei.env)], command: pinned.tei.args, publish: [80] });
  const at = (provider: typeof quickwit, port: number): string => `http://127.0.0.1:${provider.published(port)}`;
  const steps: Step<ContainerContext>[] = [
    serviceStep({ id: 'quickwit', title: 'Quickwit, the memory index\'s words,', provider: quickwit, answers: () => httpAnswers(`${at(quickwit, 7280)}/health/readyz`)() }),
    serviceStep({ id: 'qdrant', title: 'Qdrant, the memory index\'s meanings,', provider: qdrant, answers: () => httpAnswers(`${at(qdrant, 6333)}/readyz`)() }),
    serviceStep({ id: 'tei', title: 'TEI, the memory index\'s embeddings,', provider: tei, answers: () => httpAnswers(`${at(tei, 80)}/health`)() }),
  ];
  const on: ContainerContext = { commands: localCommands(process.env) };
  const reporter = memoryReporter();
  try {
    await runSteps(steps, on, reporter);
  } catch (failure) {
    await removeSteps(steps, on, reporter);
    throw failure;
  }
  return {
    index: { index: { base: at(quickwit, 7280) }, vectors: { base: at(qdrant, 6333), apiKey }, embeddings: { base: at(tei, 80) } },
    containers: { quickwit: quickwit.name, qdrant: qdrant.name, tei: tei.name },
    memoryInUse: (name) => containersOn(on.commands).memoryInUse(name),
    stop: () => removeSteps(steps, on, reporter),
  };
}
