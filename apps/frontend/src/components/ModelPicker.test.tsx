import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ModelPicker } from './ModelPicker';
import * as credentialsApi from '../api/credentials';
import * as clustersApi from '../api/clusters';
import type { ModelProvider } from '../api/models';

vi.mock('../api/credentials', async (orig) => ({
  ...(await orig<typeof credentialsApi>()),
  listLlmProviders: vi.fn(),
}));
vi.mock('../api/clusters', async (orig) => ({
  ...(await orig<typeof clustersApi>()),
  listClusters: vi.fn(),
}));

const listLlmProviders = vi.mocked(credentialsApi.listLlmProviders);
const listClusters = vi.mocked(clustersApi.listClusters);

const priced = (p: number, c: number) => ({ pricing: { promptPerMTok: p, completionPerMTok: c } });

const gateway = (model: string, over: Partial<ModelProvider> = {}): ModelProvider =>
  ({ id: model, name: `OpenRouter · ${model}`, source: 'endpoint', sourceLabel: 'OpenRouter', model, ...over }) as ModelProvider;

const local = (): ModelProvider =>
  ({ id: 'dep-1', name: 'Tabbyapi-Production', source: 'deployment', kind: 'tabbyapi',
     model: 'turboderp/Qwen3.8-27B-exl3', clusterId: 'c1', contextTokens: 32_000 }) as ModelProvider;

const models = [
  local(),
  gateway('anthropic/claude-opus-5-fast', { contextTokens: 1_000_000, intelligence: 71, ...priced(10, 50) }),
  gateway('google/gemini', priced(1, 2)),
  gateway('vendor/quiet-freebie', priced(0, 0)),
];

const setup = (over: Partial<Parameters<typeof ModelPicker>[0]> = {}) => {
  const onSelect = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ModelPicker models={models} selectedId={null} onSelect={onSelect} {...over} />
    </QueryClientProvider>,
  );
  return { onSelect };
};

beforeEach(() => {
  vi.clearAllMocks();
  listClusters.mockResolvedValue([{ id: 'c1', name: 'provisioning-lunorica' }] as never);
  listLlmProviders.mockResolvedValue([
    { provider: 'openrouter', label: 'OpenRouter', modelCount: 425, hasKey: true },
    { provider: 'groq', label: 'Groq', modelCount: 0, hasKey: false },
  ] as never);
});

describe('tiers', () => {
  it('puts what you control above what you have set up', async () => {
    setup();
    expect(await screen.findByText('Local')).toBeInTheDocument();
    expect(screen.getByText('Provisioned')).toBeInTheDocument();
  });

  it('shows a lone local model as one row naming its engine and cluster', async () => {
    setup();
    expect(await screen.findByText('turboderp/Qwen3.8-27B-exl3')).toBeInTheDocument();
    // The cluster name arrives from its own query, so it lands a tick after the model.
    expect(await screen.findByText('TabbyAPI · provisioning-lunorica · 32k')).toBeInTheDocument();
    // No group to expand for a single model.
    expect(screen.queryByLabelText('Expand TabbyAPI')).not.toBeInTheDocument();
  });

  it('falls back to the deployment name when clusters have not loaded', async () => {
    listClusters.mockResolvedValue([] as never);
    setup();
    expect(await screen.findByText('TabbyAPI · Tabbyapi-Production · 32k')).toBeInTheDocument();
  });

  it('collapses the gateway to one line whatever its size', async () => {
    setup();
    expect(await screen.findByText('OpenRouter')).toBeInTheDocument();
    expect(screen.queryByText('anthropic')).not.toBeInTheDocument();
  });
});

describe('vendors and free', () => {
  it('lists free ahead of the vendors once the gateway is open', async () => {
    setup();
    fireEvent.click(await screen.findByLabelText('Expand OpenRouter'));
    expect(screen.getByText('Free')).toBeInTheDocument();
    expect(screen.getByText('anthropic')).toBeInTheDocument();
  });

  it('groups a zero-priced model under Free even though it is not named ":free"', async () => {
    setup();
    fireEvent.click(await screen.findByLabelText('Expand OpenRouter'));
    fireEvent.click(screen.getByLabelText('Expand Free'));
    expect(screen.getByText('vendor/quiet-freebie')).toBeInTheDocument();
  });

  it('drops the vendor from a row nested under it', async () => {
    setup();
    fireEvent.click(await screen.findByLabelText('Expand OpenRouter'));
    fireEvent.click(screen.getByLabelText('Expand anthropic'));
    expect(screen.getByText('claude-opus-5-fast')).toBeInTheDocument();
  });
});

describe('prices', () => {
  it('shows dollars per million tokens beside the context window', async () => {
    setup();
    fireEvent.click(await screen.findByLabelText('Expand OpenRouter'));
    fireEvent.click(screen.getByLabelText('Expand anthropic'));
    expect(screen.getByText('$10/$50')).toBeInTheDocument();
    expect(screen.getByText('1M')).toBeInTheDocument();
  });

  it('badges the Intelligence Index beside the window and price', async () => {
    setup();
    fireEvent.click(await screen.findByLabelText('Expand OpenRouter'));
    fireEvent.click(screen.getByLabelText('Expand anthropic'));
    expect(screen.getByTitle('Artificial Analysis Intelligence Index')).toHaveTextContent('71');
  });

  it('shows no badge for a model their catalogue did not score', async () => {
    setup();
    fireEvent.click(await screen.findByLabelText('Expand OpenRouter'));
    fireEvent.click(screen.getByLabelText('Expand google'));
    expect(screen.queryByTitle('Artificial Analysis Intelligence Index')).not.toBeInTheDocument();
  });

  it('says free rather than a price', async () => {
    setup();
    fireEvent.click(await screen.findByLabelText('Expand OpenRouter'));
    fireEvent.click(screen.getByLabelText('Expand Free'));
    expect(screen.getByText('free')).toBeInTheDocument();
  });

  it('shows no price for a local model, which is not billed per token', async () => {
    setup();
    await screen.findByText('turboderp/Qwen3.8-27B-exl3');
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });
});

describe('gateways that are not set up', () => {
  it('lists a preset with no models under its own heading', async () => {
    setup();
    expect(await screen.findByText('Not set up')).toBeInTheDocument();
    expect(screen.getByText('Groq')).toBeInTheDocument();
  });

  it('does not list a gateway that is already configured', async () => {
    setup();
    await screen.findByText('Not set up');
    // OpenRouter appears once, as the provisioned source — not again as unconfigured.
    expect(screen.getAllByText('OpenRouter')).toHaveLength(1);
  });

  it('sends you somewhere to add a key', async () => {
    const onConfigure = vi.fn();
    setup({ onConfigure });
    fireEvent.click(await screen.findByText('Groq'));
    expect(onConfigure).toHaveBeenCalledWith('groq');
  });

  it('is inert when the surface offers nowhere to go', async () => {
    setup();
    expect((await screen.findByText('Groq')).closest('button')).toBeDisabled();
  });
});

describe('filtering and choosing', () => {
  it('opens matching branches, so a search never looks empty', async () => {
    setup();
    await screen.findByText('OpenRouter');
    fireEvent.change(screen.getByLabelText('Filter models'), { target: { value: 'gemini' } });
    expect(screen.getByText('gemini')).toBeInTheDocument();
    expect(screen.queryByText('anthropic')).not.toBeInTheDocument();
  });

  it('reports the chosen model', async () => {
    const { onSelect } = setup();
    fireEvent.click(await screen.findByLabelText('Expand OpenRouter'));
    fireEvent.click(screen.getByLabelText('Expand google'));
    fireEvent.click(screen.getByText('gemini'));
    expect(onSelect).toHaveBeenCalledWith('google/gemini');
  });

  it('opens down to the current choice without it being hunted for', async () => {
    setup({ selectedId: 'anthropic/claude-opus-5-fast' });
    expect(await screen.findByText('claude-opus-5-fast')).toBeInTheDocument();
  });

  it('says so when nothing matches', async () => {
    setup();
    await screen.findByText('OpenRouter');
    fireEvent.change(screen.getByLabelText('Filter models'), { target: { value: 'zzz' } });
    expect(screen.getByText(/No model matches/)).toBeInTheDocument();
  });
});
