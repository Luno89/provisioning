import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AppDashboard from './index';
import * as deploymentsApi from '../../api/deployments';
import * as modelsApi from '../../../models/api';
import type { Deployment } from '../../types/deployment';

vi.mock('../../api/deployments', async (importOriginal) => ({
  ...(await importOriginal<typeof deploymentsApi>()),
  useDeploymentPods: vi.fn(() => ({ pods: [], namespace: 'odoo', checkedAt: Date.now() })),
  useHelmStatus: vi.fn(() => ({ data: undefined })),
  useDiagnostics: vi.fn(() => ({ data: undefined })),
  useAvailableModules: vi.fn(() => ({ data: [], isLoading: false })),
  useResourcePlan: vi.fn(() => ({ data: undefined })),
  useInitialLogs: vi.fn(() => ({ data: undefined })),
  getAppSignIn: vi.fn(async () => [{ describe: 'The Hermes dashboard', login: 'admin', password: 'made-for-this-app' }]),
}));
vi.mock('../../../models/api', async (importOriginal) => ({
  ...(await importOriginal<typeof modelsApi>()),
  useTabbyImageTags: vi.fn(() => ({ options: [], loading: false })),
}));

const useHelmStatus = vi.mocked(deploymentsApi.useHelmStatus);
const useDiagnostics = vi.mocked(deploymentsApi.useDiagnostics);
const useInitialLogs = vi.mocked(deploymentsApi.useInitialLogs);

const deployment = (over: Partial<Deployment> = {}): Deployment => ({
  id: 'd1', name: 'odoo-prod', appType: 'odoo', clusterId: 'c1', status: 'running',
  strategy: 'native', ...over,
});

const setup = (d: Deployment = deployment(), initialTab: Parameters<typeof AppDashboard>[0]['initialTab'] = 'general') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <AppDashboard
        target={{ type: 'app', id: d.id }}
        deployment={d}
        deployments={[d]}
        clusters={[{ id: 'c1', name: 'dev', provider: 'machine', status: 'healthy' }]}
        cluster={null}
        initialTab={initialTab}
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
  return { onClose, user: userEvent.setup() };
};

beforeEach(() => { vi.clearAllMocks(); });

describe('the dashboard', () => {
  it('names the deployment it is showing', () => {
    setup();
    expect(screen.getByText(/odoo-prod/)).toBeDefined();
  });

  it('closes through its callback rather than App\'s setter', () => {
    const { onClose } = setup();
    screen.getByLabelText('Close dashboard').click();
    expect(onClose).toHaveBeenCalled();
  });
});

describe('the tabs', () => {
  it('shows Helm output when that tab is opened', async () => {
    useHelmStatus.mockReturnValue({ data: { content: 'REVISION: 3' } } as never);
    const { user } = setup();
    await user.click(screen.getByText('Helm Status'));
    expect(await screen.findByText(/REVISION: 3/)).toBeDefined();
  });

  it('shows diagnostics when that tab is opened', async () => {
    useDiagnostics.mockReturnValue({ data: { content: 'kube-system pod running' } } as never);
    const { user } = setup();
    await user.click(screen.getByText('Diagnostics'));
    await waitFor(() => {
      expect(document.body.textContent).toContain('kube-system pod running');
    });
  });

  it('fetches each tab\'s data only while that tab is open', () => {
    setup(deployment(), 'general');
    expect(useHelmStatus).toHaveBeenCalledWith('d1', false);
    expect(useDiagnostics).toHaveBeenCalledWith('d1', false);
  });

  it('opens on the tab it was told to', () => {
    setup(deployment(), 'provision');
    expect(useInitialLogs).toHaveBeenCalledWith(expect.anything(), true);
  });
});

describe('a failed deployment', () => {
  it('fetches the provisioning log on the General tab, where the reason actually is', () => {
    setup(deployment({ status: 'failed' }), 'general');
    expect(useInitialLogs).toHaveBeenCalledWith(expect.anything(), true);
  });

  it('shows what a deploy went ahead on without knowing, on a running app too', () => {
    setup(deployment({ status: 'running', deployNotes: ['Memory is sized for an assumed 20 GB model: Hugging Face could not be asked how big org/model is (it answered 503).'] }), 'general');
    expect(screen.getByTestId('deploy-notes').textContent).toContain('Memory is sized for an assumed 20 GB model');
  });

  it('does not fetch it for a healthy one on the same tab', () => {
    setup(deployment({ status: 'running' }), 'general');
    expect(useInitialLogs).toHaveBeenCalledWith(expect.anything(), false);
  });
});

describe('an app\'s sign-in', () => {
  it('is shown on asking for an app Koala made one for, read fresh from the backend', async () => {
    const { user } = setup(deployment({ id: 'h1', name: 'hermes', appType: 'hermes' }));
    expect(screen.queryByText('made-for-this-app')).toBeNull();
    await user.click(screen.getByText('Show sign-in'));
    expect(await screen.findByText('made-for-this-app')).toBeDefined();
    expect(screen.getByText('The Hermes dashboard')).toBeDefined();
    expect(screen.getByText('admin')).toBeDefined();
    expect(vi.mocked(deploymentsApi.getAppSignIn)).toHaveBeenCalledWith('h1');
  });

  it('is not offered for an app with no sign-in Koala made', () => {
    setup();
    expect(screen.queryByText('Show sign-in')).toBeNull();
  });
});

describe('vLLM\'s tool calling in an app\'s settings', () => {
  const served = (over: Partial<Deployment> = {}) => deployment({ appType: 'vllm', vllmModel: 'Qwen/Qwen3-8B', vllmGpuCount: 1, vllmGpuVendor: 'nvidia', ...over } as Partial<Deployment>);

  it('shows an app served without it as off, and turning it on saves the parser chosen from the model with the rest as deployed', async () => {
    const patched = vi.spyOn(deploymentsApi, 'patchDeploymentConfig').mockResolvedValue({} as never);
    const { user } = setup(served(), 'storage');
    expect(screen.getByLabelText(/^Serve tool calling/)).not.toBeChecked();
    expect(screen.getByText('Without tool calling, Koala\'s chats cannot run on this model.')).toBeInTheDocument();
    await user.click(screen.getByLabelText(/^Serve tool calling/));
    expect(screen.getByRole('option', { name: 'Chosen from the model: hermes' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Save & Restart/ }));
    expect(patched).toHaveBeenCalledWith('d1', expect.objectContaining({ vllmModel: 'Qwen/Qwen3-8B', vllmGpuCount: 1, vllmToolCallingEnabled: true, vllmToolCallParser: 'hermes' }));
  });

  it('shows the settings of the app it is switched to, not those of the one before', () => {
    const first = served();
    const second = served({ id: 'd2', name: 'mistral', vllmModel: 'mistralai/Mistral-7B-Instruct-v0.3', vllmToolCallingEnabled: true, vllmToolCallParser: 'mistral' } as Partial<Deployment>);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const shown = (d: Deployment) => (
      <QueryClientProvider client={qc}>
        <AppDashboard target={{ type: 'app', id: d.id }} deployment={d} deployments={[first, second]} clusters={[{ id: 'c1', name: 'dev', provider: 'machine', status: 'healthy' }]} cluster={null} initialTab="storage" onClose={vi.fn()} />
      </QueryClientProvider>
    );
    const { rerender } = render(shown(first));
    expect(screen.getByDisplayValue('Qwen/Qwen3-8B')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Serve tool calling/)).not.toBeChecked();
    rerender(shown(second));
    expect(screen.getByDisplayValue('mistralai/Mistral-7B-Instruct-v0.3')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Serve tool calling/)).toBeChecked();
    expect((screen.getByLabelText(/^Tool Call Parser/) as HTMLSelectElement).value).toBe('mistral');
  });

  it('asks for a parser for a model it does not know, and saves nothing until one is picked', async () => {
    const patched = vi.spyOn(deploymentsApi, 'patchDeploymentConfig').mockResolvedValue({} as never);
    const { user } = setup(served({ vllmModel: 'someone/their-own-model' }), 'storage');
    await user.click(screen.getByLabelText(/^Serve tool calling/));
    expect(screen.getByText('Koala cannot tell which tool call parser someone/their-own-model needs: pick one, or turn tool calling off.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save & Restart/ })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText(/^Tool Call Parser/), 'mistral');
    await user.click(screen.getByRole('button', { name: /Save & Restart/ }));
    expect(patched).toHaveBeenCalledWith('d1', expect.objectContaining({ vllmToolCallingEnabled: true, vllmToolCallParser: 'mistral' }));
  });
});

describe('TabbyAPI\'s memory', () => {
  it('says what to set when the model\'s size could not be read, instead of sizing it on a guess', () => {
    vi.mocked(deploymentsApi.useResourcePlan).mockReturnValue({ data: { applicable: true, unsized: 'Koala could not read how big org/model is from Hugging Face (it answered 503), so it cannot size the memory it needs.' } } as never);
    setup(deployment({ appType: 'tabbyapi', tabbyModel: 'org/model' } as Partial<Deployment>), 'storage');
    expect(screen.getByText('Koala could not read how big org/model is from Hugging Face (it answered 503), so it cannot size the memory it needs.')).toBeInTheDocument();
  });

  it('says the plan was not checked against the machine when the machine has not said how much memory it has', () => {
    const unbudgeted = 'desk has not said how much memory it has, so whether this fits there is not checked: its agent is from before machines reported their size, or it has not connected since. Once it connects with a current agent, it says.';
    vi.mocked(deploymentsApi.useResourcePlan).mockReturnValue({ data: { applicable: true, memoryLimit: '17G', shmSize: '5Gi', cpuLimit: '10', basis: '3.7 GiB of weights', unbudgeted } } as never);
    setup(deployment({ appType: 'tabbyapi', tabbyModel: 'org/model' } as Partial<Deployment>), 'storage');
    expect(screen.getByRole('alert')).toHaveTextContent(unbudgeted);
  });
});
