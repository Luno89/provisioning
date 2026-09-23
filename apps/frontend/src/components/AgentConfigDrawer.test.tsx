import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AgentConfigDrawer from './AgentConfigDrawer';
import { useShellStore } from '../stores/shell.js';

vi.mock('../api/agents', async (orig) => ({
  ...(await orig<typeof import('../api/agents.js')>()),
  listAgents: vi.fn().mockResolvedValue([
    {
      slug: 'koala', ownerId: undefined, name: 'Koala', description: 'The default conversationalist.',
      version: '1', prompt: '', guidance: '', returns: '', failures: [], procedure: 'procedure: tool-rounds',
      tools: [], agents: [], environment: { terminal: false, filesystem: false, egress: false, git: false, workspace: false, languages: [] },
      model: undefined, mine: false,
    },
    {
      slug: 'heron', ownerId: 'u-1', name: 'Heron', description: 'Does careful ground-truth writes.',
      version: '2', prompt: '', guidance: 'Always check before writing.', returns: '', failures: [], procedure: 'procedure: tool-rounds',
      tools: ['read', 'write'], agents: [], environment: { terminal: true, filesystem: true, egress: false, git: true, workspace: true, languages: ['bash'] },
      model: { endpointId: 'm2' }, mine: true,
    },
    {
      slug: 'drift', ownerId: undefined, name: 'Drift', description: '',
      version: '1', prompt: '', guidance: '', returns: '', failures: [], procedure: 'procedure: tool-rounds',
      tools: [], agents: [], environment: { terminal: false, filesystem: false, egress: false, git: false, workspace: false, languages: [] },
      model: undefined, mine: false,
    },
  ] as never),
}));

vi.mock('../api/models', async (orig) => ({
  ...(await orig<typeof import('../api/models.js')>()),
  listModels: vi.fn().mockResolvedValue([
    { id: 'm1', name: 'First', source: 'endpoint', model: 'm1-model', sourceLabel: 'Primary' },
    { id: 'm2', name: 'Second', source: 'endpoint', model: 'm2-model', sourceLabel: 'Secondary' },
  ] as never),
}));

function renderDrawer(props: { selectedAgentSlug?: string } = {}) {
  const onSelectAgent = vi.fn();
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <AgentConfigDrawer
        isOpen
        onClose={onClose}
        selectedAgentSlug={props.selectedAgentSlug ?? 'koala'}
        onSelectAgent={onSelectAgent}
      />
    </QueryClientProvider>,
  );
  return { onSelectAgent, onClose, ...utils };
}

describe('AgentConfigDrawer', () => {
  beforeEach(() => {
    useShellStore.setState({ view: 'chat' });
  });

  it('lists the seeded and owned agents, marking which one is active', async () => {
    renderDrawer({ selectedAgentSlug: 'koala' });

    await screen.findByText(/Agents \(3\)/);

    const koalaRow = await screen.findByRole('button', { name: /Koala/ });
    expect(koalaRow).toHaveTextContent('seed');
    expect(koalaRow).toHaveTextContent('Active');

    const heronRow = await screen.findByRole('button', { name: /Heron/ });
    expect(heronRow).toHaveTextContent('Yours');
  });

  it('shows the drafted agent\'s details, including its model pick and grants', async () => {
    const { container } = renderDrawer({ selectedAgentSlug: 'koala' });

    // Koala has no model of its own — it follows the conversation's pick.
    await screen.findByRole('button', { name: /Koala/ });
    expect(screen.getByText(/follows this conversation's model pick/)).toBeInTheDocument();
    expect(screen.getByText('No tools granted — pure conversation only.')).toBeInTheDocument();

    // Drafting heron swaps the details pane to her grants and pinned model.
    fireEvent.click(screen.getByRole('button', { name: /Heron/ }));
    expect(screen.getByText('read')).toBeInTheDocument();
    expect(screen.getByText('write')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/m2-model/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Always check before writing/)).toBeInTheDocument();
    expect(container.textContent).toContain('terminal');
    expect(container.textContent).toContain('bash');
  });

  it('commits the drafted agent and closes', async () => {
    const { onSelectAgent, onClose } = renderDrawer({ selectedAgentSlug: 'koala' });

    await screen.findByRole('button', { name: /Koala/ });
    fireEvent.click(screen.getByRole('button', { name: /Heron/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Use this agent/i }));

    expect(onSelectAgent).toHaveBeenCalledWith('heron');
    expect(onClose).toHaveBeenCalled();
  });

  it('points the operator at the Studio for deep editing', async () => {
    renderDrawer({ selectedAgentSlug: 'koala' });

    await screen.findByRole('button', { name: /Koala/ });
    fireEvent.click(screen.getByRole('button', { name: /Open in Studio/i }));
    expect(useShellStore.getState().view).toBe('studio');
  });
});