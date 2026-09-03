import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DefaultModelPicker } from './DefaultModelPicker';
import * as modelsApi from '../api/models';
import * as credentialsApi from '../api/credentials';
import * as clustersApi from '../api/clusters';

vi.mock('../api/models', async (orig) => ({
  ...(await orig<typeof modelsApi>()),
  listModels: vi.fn().mockResolvedValue([]),
  useDefaultModel: vi.fn(),
  setDefaultModel: vi.fn(),
  setGlobalModelOverride: vi.fn(),
}));
vi.mock('../api/credentials', async (orig) => ({
  ...(await orig<typeof credentialsApi>()),
  listLlmProviders: vi.fn().mockResolvedValue([]),
}));
vi.mock('../api/clusters', async (orig) => ({
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

/**
 * The override is a flag, never an edit to each pack — which is what makes turning it off able to
 * put every pack back on the engine it names.
 */
describe('the override toggle', () => {
  it('reads off, explaining that a pack keeps its own engine', () => {
    setup(false);
    const toggle = screen.getByRole('switch', { name: /override every pack/i });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/a pack that names its own engine keeps it/i)).toBeInTheDocument();
  });

  it('reads on, and says how to get back', () => {
    setup(true);
    expect(screen.getByRole('switch', { name: /override every pack/i })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/Turning this off puts each pack back on its own/i)).toBeInTheDocument();
  });

  it('turns the override on', async () => {
    setGlobalModelOverride.mockResolvedValue(true);
    setup(false);
    fireEvent.click(screen.getByRole('switch', { name: /override every pack/i }));
    await waitFor(() => expect(setGlobalModelOverride).toHaveBeenCalledWith(true));
  });

  it('turns it back off, which is what returns packs to their own engines', async () => {
    setGlobalModelOverride.mockResolvedValue(false);
    setup(true);
    fireEvent.click(screen.getByRole('switch', { name: /override every pack/i }));
    await waitFor(() => expect(setGlobalModelOverride).toHaveBeenCalledWith(false));
    expect(await screen.findByText(/back on the engines they name/i)).toBeInTheDocument();
  });
});
