import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ModelRateLimits } from './ModelRateLimits';
import * as harnessApi from '../api/harness';

vi.mock('../api/harness', async (importOriginal) => ({
  ...(await importOriginal<typeof harnessApi>()),
  getRateLimits: vi.fn(),
}));

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ModelRateLimits />
    </QueryClientProvider>,
  );
}

describe('ModelRateLimits', () => {
  it('renders nothing when there are no buckets', async () => {
    vi.mocked(harnessApi.getRateLimits).mockResolvedValue([]);
    const { container } = renderPanel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toBe('');
  });

  it('shows a bucket in cooldown with its queued count and 429 total', async () => {
    vi.mocked(harnessApi.getRateLimits).mockResolvedValue([{
      key: 'ep-1',
      label: 'OpenRouter · openrouter/free',
      inFlight: 1,
      queued: 3,
      cooldownUntil: new Date(Date.now() + 15_000).toISOString(),
      totalRequests: 12,
      total429: 4,
      totalErrors: 1,
      lastRequestAt: new Date(Date.now() - 5000).toISOString(),
    }]);

    renderPanel();

    expect(await screen.findByText('OpenRouter · openrouter/free')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText(/cools down in/)).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  it('shows clear for a bucket with no active cooldown', async () => {
    vi.mocked(harnessApi.getRateLimits).mockResolvedValue([{
      key: 'ep-2',
      label: 'Local vLLM',
      inFlight: 0,
      queued: 0,
      totalRequests: 5,
      total429: 0,
      totalErrors: 0,
    }]);

    renderPanel();

    expect(await screen.findByText('Local vLLM')).toBeInTheDocument();
    expect(screen.getByText('clear')).toBeInTheDocument();
  });
});
