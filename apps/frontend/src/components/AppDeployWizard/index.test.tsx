import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AppDeployWizard from './index';
import * as modelsApi from '../../api/models';
import type { Cluster } from '../../types/cluster';

vi.mock('../../api/models', async (importOriginal) => ({
  ...(await importOriginal<typeof modelsApi>()),
  useImageTags: vi.fn(() => ({ data: [], isLoading: false })),
  useHfModelSize: vi.fn(() => ({ data: undefined, isFetching: false, isError: false })),
  useModelSearch: vi.fn(() => ({ data: [], isFetching: false })),
  useTabbyImageTags: vi.fn(() => ({ options: [], loading: false })),
  useHfBranches: vi.fn(() => ({ data: [], isFetching: false })),
}));

const clusters: Cluster[] = [
  { id: 'c1', name: 'dev', provider: 'k3d', status: 'healthy' },
];

const setup = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const onDeploy = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <AppDeployWizard clusters={clusters} deployments={[]} onClose={onClose} onDeploy={onDeploy} />
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
