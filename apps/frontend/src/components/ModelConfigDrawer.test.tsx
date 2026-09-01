import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ModelConfigDrawer } from './ModelConfigDrawer';
import * as modelsApi from '../api/models';
import type { ModelProvider } from '../api/models';

vi.mock('../api/models', async (orig) => ({
  ...(await orig<typeof modelsApi>()),
  listModels: vi.fn(),
  useDefaultModel: vi.fn(),
}));

vi.mock('../api/credentials', async (orig) => ({
  ...(await orig<typeof import('../api/credentials')>()),
  listLlmProviders: vi.fn().mockResolvedValue([]),
}));

vi.mock('../api/clusters', async (orig) => ({
  ...(await orig<typeof import('../api/clusters')>()),
  listClusters: vi.fn().mockResolvedValue([]),
}));

const listModels = vi.mocked(modelsApi.listModels);
const useDefaultModel = vi.mocked(modelsApi.useDefaultModel);

const model = (id: string, name: string): ModelProvider =>
  ({ id, name: `OpenRouter · ${name}`, source: 'endpoint', sourceLabel: 'OpenRouter', model: name }) as ModelProvider;

const setup = (selectedModelId: string | null, defaultId: string | null = 'd1') => {
  const onSelectModel = vi.fn();
  const onClose = vi.fn();
  listModels.mockResolvedValue([model('d1', 'anthropic/opus'), model('m2', 'google/gemini')]);
  useDefaultModel.mockReturnValue({
    data: { defaultModelId: defaultId, globalModelOverride: false },
  } as never);

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ModelConfigDrawer isOpen onClose={onClose} selectedModelId={selectedModelId} onSelectModel={onSelectModel} />
    </QueryClientProvider>,
  );
  return { onSelectModel, onClose };
};

beforeEach(() => vi.clearAllMocks());

describe('ModelConfigDrawer', () => {
  it('renders nothing when closed, so it costs no query', () => {
    useDefaultModel.mockReturnValue({
      data: { defaultModelId: null, globalModelOverride: false },
    } as never);
    const qc = new QueryClient();
    const { container } = render(
      <QueryClientProvider client={qc}>
        <ModelConfigDrawer isOpen={false} onClose={vi.fn()} selectedModelId={null} onSelectModel={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('names the account default as what answers when nothing is pinned', async () => {
    setup(null);
    expect(await screen.findByText('(account default)')).toBeInTheDocument();
    expect(screen.getByText('[OpenRouter] anthropic/opus')).toBeInTheDocument();
  });

  it('pins a model and closes', async () => {
    const { onSelectModel, onClose } = setup(null);
    // Source, then vendor, then the model — each collapsed until asked for.
    fireEvent.click(await screen.findByLabelText('Expand OpenRouter'));
    fireEvent.click(screen.getByLabelText('Expand google'));
    fireEvent.click(screen.getByText('gemini'));
    expect(onSelectModel).toHaveBeenCalledWith('m2');
    expect(onClose).toHaveBeenCalled();
  });

  it('hands the conversation back to the account default', async () => {
    const { onSelectModel } = setup('m2');
    fireEvent.click(await screen.findByText(/Follow the account default/));
    // null is the choice "follow the default", not an absence of one.
    expect(onSelectModel).toHaveBeenCalledWith(null);
  });

  it('warns when there is no account default to fall back to', async () => {
    setup(null, null);
    expect(await screen.findByText(/no account default set/)).toBeInTheDocument();
  });
});
