import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AppDeployWizard from './index';
import * as modelsApi from '../../../models/api';
import * as deploymentsApi from '../../api/deployments';
import type { Cluster } from '../../types/cluster';
import type { CatalogueEntry } from '../../api/deployments';

const catalogueFixture: CatalogueEntry[] = [
  {
    id: 'wordpress',
    deploysFromSpec: false,
    uiDefaults: {
      helm: { webRepo: 'bitnamilegacy/wordpress', webTag: 'latest', dbRepo: 'bitnamilegacy/mariadb', dbTag: 'latest' },
      native: { webRepo: 'library/wordpress', webTag: 'apache', dbRepo: 'library/mariadb', dbTag: 'latest' },
      hasDatabase: true,
      strategies: ['helm', 'native'],
    },
  },
  {
    id: 'vllm',
    deploysFromSpec: false,
    uiDefaults: {
      helm: { webRepo: '', webTag: '', dbRepo: '', dbTag: '' },
      native: { webRepo: 'vllm/vllm-openai', webTag: 'latest', dbRepo: '', dbTag: '' },
      hasDatabase: false,
      strategies: ['native'],
      gpuOnly: true,
    },
  },
  {
    id: 'tabbyapi',
    deploysFromSpec: false,
    uiDefaults: {
      helm: { webRepo: '', webTag: '', dbRepo: '', dbTag: '' },
      native: { webRepo: 'ghcr.io/theroyallab/tabbyapi', webTag: 'latest', dbRepo: '', dbTag: '' },
      hasDatabase: false,
      strategies: ['native'],
      gpuOnly: true,
    },
  },
];

vi.mock('../../api/deployments', async (importOriginal) => ({
  ...(await importOriginal<typeof deploymentsApi>()),
  useAppCatalogue: vi.fn(() => ({ data: catalogueFixture, isLoading: false })),
}));

const modelsApiEmptyPage = {
  tags: [] as string[], page: 1, pageSize: 30, total: 0, totalPages: 1, sort: 'newest' as const,
};

vi.mock('../../../models/api', async (importOriginal) => ({
  ...(await importOriginal<typeof modelsApi>()),
  useImageTags: vi.fn(() => ({ data: modelsApiEmptyPage, isLoading: false, isFetching: false })),
  useHfModelSize: vi.fn(() => ({ data: undefined, isFetching: false, isError: false })),
  useModelSearch: vi.fn(() => ({ data: [], isFetching: false })),
  useTabbyImageTags: vi.fn(() => ({ options: [], loading: false })),
  useHfBranches: vi.fn(() => ({ data: [], isFetching: false })),
}));

const clusters: Cluster[] = [
  { id: 'c1', name: 'dev', provider: 'machine', status: 'healthy' },
  { id: 'gpu1', name: 'rig', provider: 'machine', status: 'healthy', gpus: [{ vendor: 'nvidia', model: 'RTX 3090', memoryMiB: 24576, count: 1, runtime: true }] },
];

const setup = (given: Cluster[] = clusters) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const onDeploy = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <AppDeployWizard clusters={given} deployments={[]} onClose={onClose} onDeploy={onDeploy} />
    </QueryClientProvider>,
  );
  return { onClose, onDeploy, user: userEvent.setup() };
};

beforeEach(() => { vi.clearAllMocks(); });

describe('the deploy wizard', () => {
  it('opens on the cluster step, offering the clusters it was given', () => {
    setup();
    expect(screen.getByRole('option', { name: /dev/ })).toBeDefined();
  });

  it('closes through its callback, not by reaching into App', () => {
    const { onClose } = setup();
    screen.getByLabelText('Close Wizard').click();
    expect(onClose).toHaveBeenCalled();
  });

  it('starts from a clean slate every time it mounts', () => {
    setup();
    expect(screen.getByDisplayValue('Odoo-Production')).toBeDefined();
  });
});

describe('reaching the parent on deploy', () => {
  async function walkToConfirm(user: ReturnType<typeof userEvent.setup>, appType: string) {
    await user.selectOptions(screen.getByLabelText(/target cluster/i), 'c1');
    await user.selectOptions(screen.getByLabelText(/application type/i), appType);
    for (let i = 0; i < 5; i++) {
      const next = screen.queryByRole('button', { name: /^Next/ });
      if (!next) break;
      await user.click(next);
    }
  }

  it('calls onDeploy with the assembled payload when Initiate Deployment is clicked', async () => {
    const { onDeploy, user } = setup();
    await walkToConfirm(user, 'wordpress');

    const initiate = screen.getByRole('button', { name: /Initiate Deployment/ });
    await user.click(initiate);

    expect(onDeploy).toHaveBeenCalledTimes(1);
    const payload = onDeploy.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.appType).toBe('wordpress');
    expect(payload.clusterId).toBe('c1');
    expect(payload.pgRepo).toBeTruthy();
    expect(payload.pgTag).toBeTruthy();
  });
});

describe('the model step for vLLM and TabbyAPI', () => {
  const useModelSearch = vi.mocked(modelsApi.useModelSearch);

  async function walkToModelStep(user: ReturnType<typeof userEvent.setup>, appType: string) {
    await user.selectOptions(screen.getByLabelText(/application type/i), appType);
    await user.selectOptions(screen.getByLabelText(/target cluster/i), 'gpu1');
    await user.click(screen.getByRole('button', { name: /^Next/ }));
    await user.click(screen.getByRole('button', { name: /^Next/ }));
  }

  it.each(['vllm', 'tabbyapi'])('runs the model search on the step that renders it (%s)', async (appType) => {
    const { user } = setup();
    await walkToModelStep(user, appType);

    expect(screen.getByPlaceholderText(/qwen|llama|mistral/i)).toBeInTheDocument();
    expect(useModelSearch).toHaveBeenLastCalledWith(appType, '', true);
  });

  it('lists the models the search returns', async () => {
    useModelSearch.mockReturnValue({
      data: [{ id: 'turboderp/Qwen3-27B-exl3', downloads: 42 }], isFetching: false,
    } as unknown as ReturnType<typeof modelsApi.useModelSearch>);

    const { user } = setup();
    await walkToModelStep(user, 'tabbyapi');

    expect(screen.getByText('Qwen3-27B-exl3')).toBeInTheDocument();
    expect(screen.getByText(/turboderp\/Qwen3-27B-exl3 · 42 downloads/)).toBeInTheDocument();
  });

  it('leaves the search idle for app types that have no model step', async () => {
    const { user } = setup();
    await user.selectOptions(screen.getByLabelText(/application type/i), 'jellyfin');
    await user.selectOptions(screen.getByLabelText(/target cluster/i), 'c1');
    await user.click(screen.getByRole('button', { name: /^Next/ }));
    await user.click(screen.getByRole('button', { name: /^Next/ }));

    expect(useModelSearch).toHaveBeenLastCalledWith('jellyfin', '', false);
  });
});

describe('the cluster step for an app that needs a GPU', () => {
  const offered = (): string[] => Array.from((screen.getByLabelText(/target cluster/i) as HTMLSelectElement).options, (option: HTMLOptionElement) => option.value).filter(Boolean);

  it('offers only the machines that report a GPU, and picks the one there is', async () => {
    const { user } = setup();
    await user.selectOptions(screen.getByLabelText(/application type/i), 'vllm');
    expect(offered()).toEqual(['gpu1']);
    expect((screen.getByLabelText(/target cluster/i) as HTMLSelectElement).value).toBe('gpu1');
    expect(screen.getByText(/Only machines that report a GPU are shown/)).toBeInTheDocument();
  });

  it('says none of the machines reports a GPU, with the problem a machine had reading its GPUs', async () => {
    const { user } = setup([{ id: 'c1', name: 'dev', provider: 'machine', status: 'healthy', gpus: [], gpuProblems: ['nvidia-smi is installed but does not answer'] }]);
    await user.selectOptions(screen.getByLabelText(/application type/i), 'vllm');
    expect(offered()).toEqual([]);
    expect(screen.getByText(/None of your machines reports a GPU/)).toBeInTheDocument();
    expect(screen.getByText('dev: nvidia-smi is installed but does not answer')).toBeInTheDocument();
  });
});

describe('every field the wizard shows', () => {
  const unnamed = (): string[] => Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea'))
    .filter((field) => !field.labels?.length && !field.getAttribute('aria-label') && !field.getAttribute('aria-labelledby'))
    .map((field) => field.outerHTML.slice(0, 120));

  it.each(['vllm', 'tabbyapi', 'wordpress'])('is named by its label on every step (%s)', async (appType) => {
    const { user } = setup();
    await user.selectOptions(screen.getByLabelText(/application type/i), appType);
    if (appType === 'wordpress') await user.selectOptions(screen.getByLabelText(/target cluster/i), 'c1');
    expect(unnamed()).toEqual([]);
    for (let step = 0; step < 5; step++) {
      const next = screen.queryByRole('button', { name: /^Next/ });
      if (!next) break;
      await user.click(next);
      for (const advanced of screen.queryAllByRole('button', { name: /Advanced/ })) await user.click(advanced);
      expect(unnamed()).toEqual([]);
    }
  });
});

describe('the GPUs a model server is offered', () => {
  const options = (label: RegExp): string[] => Array.from((screen.getByLabelText(label) as HTMLSelectElement).options, (option: HTMLOptionElement) => option.value)

  async function walkToGpus(user: ReturnType<typeof userEvent.setup>, appType: string) {
    await user.selectOptions(screen.getByLabelText(/application type/i), appType);
    for (let step = 0; step < 3; step++) await user.click(screen.getByRole('button', { name: /^Next/ }));
  }

  it('offers vLLM the vendors and counts the chosen machine reports, never CPU only, and sends what was chosen', async () => {
    const { user, onDeploy } = setup([{ id: 'rig', name: 'rig', provider: 'machine', status: 'healthy', gpus: [{ vendor: 'nvidia', model: 'RTX 3090', memoryMiB: 24576, count: 2, runtime: true }] }]);
    await walkToGpus(user, 'vllm');
    expect(options(/^GPU Vendor/)).toEqual(['nvidia']);
    expect(options(/^GPU Count/)).toEqual(['1', '2']);
    await user.type(screen.getByLabelText(/^HuggingFace Model ID/), 'Qwen/Qwen2.5-0.5B-Instruct');
    await user.selectOptions(screen.getByLabelText(/^GPU Count/), '2');
    await user.click(screen.getByRole('button', { name: /^Next/ }));
    await user.click(screen.getByRole('button', { name: /Initiate Deployment/ }));
    const payload = onDeploy.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).toMatchObject({ appType: 'vllm', clusterId: 'rig', vllmGpuCount: 2, vllmGpuVendor: 'nvidia', vllmModel: 'Qwen/Qwen2.5-0.5B-Instruct' });
    expect(payload).not.toHaveProperty('odooTag');
  });

  it('offers no count and goes no further, saying why, when the machine cannot pass its GPUs to a pod', async () => {
    const { user } = setup([{ id: 'rig', name: 'rig', provider: 'machine', status: 'healthy', gpus: [{ vendor: 'nvidia', model: 'RTX 3090', memoryMiB: 24576, count: 2, runtime: false }] }]);
    await walkToGpus(user, 'vllm');
    expect(options(/^GPU Count/)).toEqual([]);
    expect(screen.getByRole('button', { name: /^Next/ })).toBeDisabled();
    expect(screen.getByText(/rig has 2 NVIDIA GPUs, and pods there cannot be given them yet: NVIDIA's CDI support is not installed/)).toBeInTheDocument();
  });

  it('offers TabbyAPI the NVIDIA GPUs the machine reports, and no CPU only, which it has not', async () => {
    const { user } = setup([{ id: 'rig', name: 'rig', provider: 'machine', status: 'healthy', gpus: [{ vendor: 'nvidia', model: 'RTX 3090', memoryMiB: 24576, count: 1, runtime: true }] }]);
    await walkToGpus(user, 'tabbyapi');
    expect(options(/^GPU Count/)).toEqual(['1']);
    expect((screen.getByLabelText(/^GPU Count/) as HTMLSelectElement).value).toBe('1');
  });
});

describe('a model whose size cannot be read', () => {
  it.each(['vllm', 'tabbyapi'])('says so as a problem, with the reason, and never that deploying will work anyway (%s)', async (appType) => {
    vi.mocked(modelsApi.useHfModelSize).mockReturnValue({ data: undefined, isFetching: false, isError: true, error: new Error('Hugging Face answered 404 for Qwen/Nope') } as unknown as ReturnType<typeof modelsApi.useHfModelSize>);
    const { user } = setup();
    await user.selectOptions(screen.getByLabelText(/application type/i), appType);
    for (let step = 0; step < 3; step++) await user.click(screen.getByRole('button', { name: /^Next/ }));
    expect(screen.getByText('Koala could not read this model\'s size from Hugging Face: Hugging Face answered 404 for Qwen/Nope. How much it downloads and how much GPU memory it needs are not known; check the model ID.')).toBeInTheDocument();
    expect(screen.queryByText(/will still work/)).toBeNull();
  });
});
