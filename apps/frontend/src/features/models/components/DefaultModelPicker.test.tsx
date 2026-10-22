import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DefaultModelPicker } from './DefaultModelPicker';
import * as modelsApi from '../api';
import * as credentialsApi from '../../infrastructure/api/credentials';
import * as clustersApi from '../../infrastructure/api/clusters';

vi.mock('../api', async (orig) => ({
  ...(await orig<typeof modelsApi>()),
  listModels: vi.fn().mockResolvedValue([]),
  useDefaultModel: vi.fn(),
  setDefaultModel: vi.fn(),
  setGlobalModelOverride: vi.fn(),
}));
vi.mock('../../infrastructure/api/credentials', async (orig) => ({
  ...(await orig<typeof credentialsApi>()),
  listLlmProviders: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../infrastructure/api/clusters', async (orig) => ({
  ...(await orig<typeof clustersApi>()),
  listClusters: vi.fn().mockResolvedValue([]),
}));

const useDefaultModel = vi.mocked(modelsApi.useDefaultModel);
const setGlobalModelOverride = vi.mocked(modelsApi.setGlobalModelOverride);

const setup = (globalModelOverride: boolean) => {
  useDefaultModel.mockReturnValue({
    data: { defaultModelId: 'm1', globalModelOverride },
  } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <DefaultModelPicker />
    </QueryClientProvider>,
  );
};

beforeEach(() => vi.clearAllMocks());

describe('the override toggle', () => {
  it('reads off, explaining that an agent keeps its own model', () => {
    setup(false);
    const toggle = screen.getByRole('switch', { name: /override every agent/i });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/an agent that names its own model keeps it/i)).toBeInTheDocument();
  });

  it('reads on, and says how to get back', () => {
    setup(true);
    expect(screen.getByRole('switch', { name: /override every agent/i })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/Turning this off puts each agent back on its own/i)).toBeInTheDocument();
  });

  it('turns the override on', async () => {
    setGlobalModelOverride.mockResolvedValue(true);
    setup(false);
    fireEvent.click(screen.getByRole('switch', { name: /override every agent/i }));
    await waitFor(() => expect(setGlobalModelOverride).toHaveBeenCalledWith(true));
  });

  it('turns it back off, which is what returns agents to their own models', async () => {
    setGlobalModelOverride.mockResolvedValue(false);
    setup(true);
    fireEvent.click(screen.getByRole('switch', { name: /override every agent/i }));
    await waitFor(() => expect(setGlobalModelOverride).toHaveBeenCalledWith(false));
    expect(await screen.findByText(/back on the models they name/i)).toBeInTheDocument();
  });
});
