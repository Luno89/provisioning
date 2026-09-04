import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import CollapsibleHistoryList from './CollapsibleHistoryList.js';
import type { ChatConversation } from '../api/chat-pack.js';

describe('CollapsibleHistoryList — Collapsible Chat History Drawer', () => {
  const sampleConversations: ChatConversation[] = [
    {
      id: 'c-1',
      title: 'Database Cluster Migration',
      messageCount: 4,
      updatedAt: '2026-08-26T00:00:00Z',
      messages: [{ role: 'user', content: 'hello database' }],
    },
    {
      id: 'c-2',
      title: 'Hetzner Node Provisioning',
      messageCount: 2,
      updatedAt: '2026-08-26T01:00:00Z',
      proposedTrees: [{ id: 't-1', name: 'Hetzner', type: 'k8s', goal: 'Deploy k8s', proposedAt: '2026-08-26T00:00:00Z' }],
    },
  ];

  it('renders nothing or 0-width when isOpen is false', () => {
    const { container } = render(
      <CollapsibleHistoryList
        conversations={sampleConversations}
        activeId="c-1"
        isOpen={false}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        onNewChat={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    expect(container.querySelector('[data-testid="history-list-panel"]')).toBeNull();
  });

  it('renders history items with titles, message count, and proposals when isOpen is true', () => {
    render(
      <CollapsibleHistoryList
        conversations={sampleConversations}
        activeId="c-1"
        isOpen={true}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        onNewChat={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    expect(screen.getByText('Database Cluster Migration')).toBeInTheDocument();
    expect(screen.getByText('Hetzner Node Provisioning')).toBeInTheDocument();
    expect(screen.getByText(/4 msgs/i)).toBeInTheDocument();
    expect(screen.getByText('Tree')).toBeInTheDocument();
  });

  it('filters conversations when search input is typed', () => {
    render(
      <CollapsibleHistoryList
        conversations={sampleConversations}
        activeId="c-1"
        isOpen={true}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        onNewChat={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    const searchInput = screen.getByPlaceholderText(/search/i);
    fireEvent.change(searchInput, { target: { value: 'Hetzner' } });

    expect(screen.getByText('Hetzner Node Provisioning')).toBeInTheDocument();
    expect(screen.queryByText('Database Cluster Migration')).toBeNull();
  });

  it('triggers onSelect when conversation item is clicked', () => {
    const onSelect = vi.fn();
    render(
      <CollapsibleHistoryList
        conversations={sampleConversations}
        activeId="c-1"
        isOpen={true}
        onToggle={vi.fn()}
        onSelect={onSelect}
        onNewChat={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText('Hetzner Node Provisioning'));
    expect(onSelect).toHaveBeenCalledWith('c-2');
  });

  it('triggers onDelete when delete icon button is clicked', () => {
    const onDelete = vi.fn();
    render(
      <CollapsibleHistoryList
        conversations={sampleConversations}
        activeId="c-1"
        isOpen={true}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        onNewChat={vi.fn()}
        onDelete={onDelete}
      />
    );

    const deleteButtons = screen.getAllByRole('button', { name: /delete conversation/i });
    fireEvent.click(deleteButtons[0]!);
    expect(onDelete).toHaveBeenCalledWith('c-1');
  });
});
