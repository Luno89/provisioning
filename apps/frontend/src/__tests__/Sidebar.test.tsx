import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useShellStore, type ViewName } from '../stores/shell';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Box, Server } from 'lucide-react';
import Sidebar from '../components/Sidebar';
import * as chatPackApi from '../api/chat-pack.js';

vi.mock('../api/chat-pack.js', async (importOriginal) => ({
  ...(await importOriginal<typeof chatPackApi>()),
  listChatConversations: vi.fn(),
}));

const TABS = [
  { id: 'clusters', label: 'Clusters', icon: Server },
  { id: 'apps', label: 'Applications', icon: Box },
];

const createTestQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

const setup = (init: { view?: ViewName; forestOpen?: boolean } = {}) => {
  useShellStore.setState({ view: init.view ?? 'chat', forestOpen: init.forestOpen ?? false });
  const onLogout = vi.fn();
  const qc = createTestQueryClient();
  render(
    <QueryClientProvider client={qc}>
      <Sidebar forestTabs={TABS} onLogout={onLogout} />
    </QueryClientProvider>
  );
  return {
    onLogout,
    view: () => useShellStore.getState().view,
    forestOpen: () => useShellStore.getState().forestOpen,
  };
};

describe('what the nav offers', () => {
  it('renders the harness entries', () => {
    setup();
    for (const label of ['Koala', 'Projects', 'Personas', 'Lab', 'Forest']) {
      expect(screen.getByText(label), label).toBeInTheDocument();
    }
  });

  it('keeps the Forest tabs hidden until it is opened', () => {
    // Lab used to live two levels down inside Forest, whose open state was not persisted — so
    // collapsing Forest made it vanish. It is a sibling now, and must not be inside this.
    setup();
    expect(screen.queryByText('Clusters')).not.toBeInTheDocument();
    expect(screen.getByText('Lab')).toBeInTheDocument();
  });

  it('shows them when it is open', () => {
    setup({ forestOpen: true });
    expect(screen.getByText('Clusters')).toBeInTheDocument();
    expect(screen.getByText('Applications')).toBeInTheDocument();
  });
});

describe('what clicking does', () => {
  it('navigates to each harness view', () => {
    // Asserts the shell actually moved, rather than that a prop was called with a string.
    const { view } = setup();
    for (const [label, id] of [['Koala', 'chat'], ['Projects', 'grove'], ['Personas', 'personas'], ['Lab', 'lab']]) {
      fireEvent.click(screen.getByText(label!));
      expect(view(), label).toBe(id);
    }
  });

  it('navigates to a Forest tab by its id', () => {
    const { view } = setup({ forestOpen: true });
    fireEvent.click(screen.getByText('Applications'));
    expect(view()).toBe('apps');
  });

  it('toggles Forest rather than setting it', () => {
    // Both directions from one handler, which is why the action accepts an updater.
    const { forestOpen } = setup({ forestOpen: false });
    fireEvent.click(screen.getByText('Forest'));
    expect(forestOpen()).toBe(true);
    fireEvent.click(screen.getByText('Forest'));
    expect(forestOpen()).toBe(false);
  });

  it('logs out', () => {
    const { onLogout } = setup();
    fireEvent.click(screen.getByText('Log Out'));
    expect(onLogout).toHaveBeenCalled();
  });
});

describe('what the current view looks like', () => {
  it('marks the active entry, so you can tell where you are', () => {
    setup({ view: 'lab' });
    expect(screen.getByText('Lab').className).toMatch(/bg-\[var\(--bark-600\)\]/);
    expect(screen.getByText('Personas').className).not.toMatch(/bg-\[var\(--bark-600\)\]/);
  });

  it('marks the active Forest tab too', () => {
    setup({ view: 'apps', forestOpen: true });
    expect(screen.getByText('Applications').className).toMatch(/bg-\[var\(--bark-600\)\]/);
  });

  it('renders recent chat conversations under Koala when on chat view', async () => {
    vi.mocked(chatPackApi.listChatConversations).mockResolvedValue([
      { id: 'c-1', title: 'Production Cluster Migration', messageCount: 4, updatedAt: '2026-08-26T00:00:00Z', messages: [] },
      { id: 'c-2', title: 'Spec Configuration', messageCount: 2, updatedAt: '2026-08-26T01:00:00Z', proposedSpecs: [{ id: 's-1', title: 'MinIO' }], messages: [] },
    ]);

    setup({ view: 'chat' });

    expect(await screen.findByText('Production Cluster Migration')).toBeInTheDocument();
    expect(screen.getByText('Spec Configuration')).toBeInTheDocument();
    expect(screen.getByTitle('App Spec')).toBeInTheDocument();
  });
});
