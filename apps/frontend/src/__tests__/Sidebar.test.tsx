import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useShellStore, type ViewName } from '../stores/shell';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Box, Server } from 'lucide-react';
import Sidebar from '../components/Sidebar';
import * as chatPackApi from '../api/chat-pack.js';
import * as groveApi from '../api/grove.js';

vi.mock('../api/chat-pack.js', async (importOriginal) => ({
  ...(await importOriginal<typeof chatPackApi>()),
  listChatConversations: vi.fn(),
  deleteChatConversation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../api/grove.js', async (importOriginal) => ({
  ...(await importOriginal<typeof groveApi>()),
  listTrees: vi.fn().mockResolvedValue([]),
}));

afterEach(() => {
  window.location.hash = '';
});

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

const setup = (init: {
  view?: ViewName; forestOpen?: boolean; koalaOpen?: boolean; projectsOpen?: boolean;
} = {}) => {
  useShellStore.setState({
    view: init.view ?? 'chat',
    forestOpen: init.forestOpen ?? false,
    koalaOpen: init.koalaOpen ?? true,
    projectsOpen: init.projectsOpen ?? true,
  });
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
    koalaOpen: () => useShellStore.getState().koalaOpen,
    projectsOpen: () => useShellStore.getState().projectsOpen,
  };
};

describe('what the nav offers', () => {
  it('renders the harness entries', () => {
    setup();
    for (const label of ['Koala', 'Projects', 'Personas', 'Lab', 'Harness', 'Tool Repo', 'Forest']) {
      expect(screen.getByText(label), label).toBeInTheDocument();
    }
  });

  it('keeps the Forest tabs hidden until it is opened', () => {
    setup();
    expect(screen.queryByText('Clusters')).not.toBeInTheDocument();
    expect(screen.getByText('Lab')).toBeInTheDocument();
  });

  it('shows them when it is open', () => {
    setup({ forestOpen: true });
    expect(screen.getByText('Clusters')).toBeInTheDocument();
    expect(screen.getByText('Applications')).toBeInTheDocument();
  });

  it('keeps Recent Chats hidden when Koala is collapsed, but leaves Personas/Lab/Harness/Tool Repo visible — they are flat siblings, not nested under Koala', async () => {
    vi.mocked(chatPackApi.listChatConversations).mockResolvedValue([
      { id: 'c-1', title: 'Some Chat', messageCount: 1, updatedAt: '2026-08-26T00:00:00Z', messages: [] },
    ]);

    setup({ view: 'chat', koalaOpen: false });

    expect(screen.queryByText('Some Chat')).not.toBeInTheDocument();
    expect(screen.getByText('Personas')).toBeInTheDocument();
    expect(screen.getByText('Lab')).toBeInTheDocument();
    expect(screen.getByText('Harness')).toBeInTheDocument();
    expect(screen.getByText('Tool Repo')).toBeInTheDocument();
  });

  it('keeps the tree list hidden when the Projects group is collapsed', () => {
    vi.mocked(groveApi.listTrees).mockResolvedValue([
      { id: 't-1', name: 'Odoo Rollout', type: 'default', branchCount: 3, updatedAt: '2026-08-26T00:00:00Z' },
    ]);
    setup({ view: 'grove', projectsOpen: false });
    expect(screen.queryByText('Odoo Rollout')).not.toBeInTheDocument();
  });
});

describe('what clicking does', () => {
  it('navigates to Projects, Personas and Lab from chat', () => {
    const { view } = setup();
    for (const [label, id] of [['Projects', 'grove'], ['Personas', 'personas'], ['Lab', 'lab']]) {
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

  it('navigating into Koala from elsewhere lands on chat with the group open', () => {
    const { view, koalaOpen } = setup({ view: 'lab', koalaOpen: false });
    fireEvent.click(screen.getByText('Koala'));
    expect(view()).toBe('chat');
    expect(koalaOpen()).toBe(true);
  });

  it('clicking Koala again while already on chat collapses the group instead of re-navigating', () => {
    const { view, koalaOpen } = setup({ view: 'chat', koalaOpen: true });
    fireEvent.click(screen.getByText('Koala'));
    expect(view()).toBe('chat');
    expect(koalaOpen()).toBe(false);
    fireEvent.click(screen.getByText('Koala'));
    expect(koalaOpen()).toBe(true);
  });

  it('navigating into Projects from elsewhere lands on grove with the group open', () => {
    const { view, projectsOpen } = setup({ view: 'lab', projectsOpen: false });
    fireEvent.click(screen.getByText('Projects'));
    expect(view()).toBe('grove');
    expect(projectsOpen()).toBe(true);
  });

  it('clicking Projects again while already on grove collapses the group instead of re-navigating', () => {
    const { view, projectsOpen } = setup({ view: 'grove', projectsOpen: true });
    fireEvent.click(screen.getByText('Projects'));
    expect(view()).toBe('grove');
    expect(projectsOpen()).toBe(false);
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
      { id: 'c-2', title: 'Spec Configuration', messageCount: 2, updatedAt: '2026-08-26T01:00:00Z', proposedSpecs: [{ id: 's-1', spec: {}, proposedAt: '2026-08-26T01:00:00Z' }], messages: [] },
    ]);

    setup({ view: 'chat' });

    expect(await screen.findByText('Production Cluster Migration')).toBeInTheDocument();
    expect(screen.getByText('Spec Configuration')).toBeInTheDocument();
    expect(screen.getByTitle('App Spec')).toBeInTheDocument();
  });

  it('marks the conversation matching the URL hash as active, not the wrong one', async () => {
    vi.mocked(chatPackApi.listChatConversations).mockResolvedValue([
      { id: 'c-1', title: 'First Chat', messageCount: 1, updatedAt: '2026-08-26T00:00:00Z', messages: [] },
      { id: 'c-2', title: 'Second Chat', messageCount: 1, updatedAt: '2026-08-26T00:00:00Z', messages: [] },
    ]);
    window.location.hash = '#/chat/c-2';

    setup({ view: 'chat' });

    await screen.findByText('Second Chat');
    expect(screen.getByText('Second Chat').closest('button')!.className).toMatch(/bg-\[var\(--bark-600\)\]/);
    expect(screen.getByText('First Chat').closest('button')!.className).not.toMatch(/bg-\[var\(--bark-600\)\]/);
  });
});

describe('deleting a conversation', () => {
  it('deletes it and navigates away when it was the one open', async () => {
    vi.mocked(chatPackApi.listChatConversations).mockResolvedValue([
      { id: 'c-1', title: 'Old Chat', messageCount: 1, updatedAt: '2026-08-26T00:00:00Z', messages: [] },
    ]);
    window.location.hash = '#/chat/c-1';

    setup({ view: 'chat' });
    await screen.findByText('Old Chat');

    fireEvent.click(screen.getByLabelText('Delete conversation'));

    await waitFor(() => expect(chatPackApi.deleteChatConversation).toHaveBeenCalledWith('c-1'));
    await waitFor(() => expect(window.location.hash).toBe('#/chat'));
  });

  it('leaves the current view alone when the deleted conversation was not the active one', async () => {
    vi.mocked(chatPackApi.listChatConversations).mockResolvedValue([
      { id: 'c-1', title: 'Not Active', messageCount: 1, updatedAt: '2026-08-26T00:00:00Z', messages: [] },
    ]);
    window.location.hash = '#/chat/some-other-id';

    setup({ view: 'chat' });
    await screen.findByText('Not Active');

    fireEvent.click(screen.getByLabelText('Delete conversation'));

    await waitFor(() => expect(chatPackApi.deleteChatConversation).toHaveBeenCalledWith('c-1'));
    expect(window.location.hash).toBe('#/chat/some-other-id');
  });
});

describe('the tree list under Projects', () => {
  it('renders trees and navigates to one by hash on click', async () => {
    vi.mocked(groveApi.listTrees).mockResolvedValue([
      { id: 't-1', name: 'Odoo Rollout', type: 'default', branchCount: 3, updatedAt: '2026-08-26T00:00:00Z' },
    ]);

    setup({ view: 'grove' });

    await screen.findByText('Odoo Rollout');
    fireEvent.click(screen.getByText('Odoo Rollout'));

    expect(window.location.hash).toBe('#/grove/t-1');
  });

  it('marks the tree matching the URL hash as active', async () => {
    vi.mocked(groveApi.listTrees).mockResolvedValue([
      { id: 't-1', name: 'Tree One', type: 'default', branchCount: 1, updatedAt: '2026-08-26T00:00:00Z' },
      { id: 't-2', name: 'Tree Two', type: 'default', branchCount: 1, updatedAt: '2026-08-26T00:00:00Z' },
    ]);
    window.location.hash = '#/grove/t-2';

    setup({ view: 'grove' });

    await screen.findByText('Tree Two');
    expect(screen.getByText('Tree Two').closest('button')!.className).toMatch(/bg-\[var\(--bark-600\)\]/);
    expect(screen.getByText('Tree One').closest('button')!.className).not.toMatch(/bg-\[var\(--bark-600\)\]/);
  });

  it('stays out of the way when there are no trees', () => {
    setup({ view: 'grove' });
    expect(screen.queryByText(/branch/i)).not.toBeInTheDocument();
  });
});
