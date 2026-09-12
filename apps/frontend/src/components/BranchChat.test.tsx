import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import BranchChat from './BranchChat.js';

vi.mock('./ChatSurface.js', () => ({
  default: () => <div data-testid="chat-surface">ChatSurface Mock</div>,
}));

vi.mock('./AcceptancePlan.js', () => ({
  default: () => <div data-testid="acceptance-plan">AcceptancePlan Mock</div>,
}));

vi.mock('./AcceptanceEditor.js', () => ({
  default: () => <div data-testid="acceptance-editor">AcceptanceEditor Mock</div>,
}));

vi.mock('./Delivery.js', () => ({
  default: () => <div data-testid="delivery-stages">Delivery Mock</div>,
}));

describe('BranchChat — stages collapsible state', () => {
  const mockRecord = {
    id: 'branch-1',
    title: 'Test Branch',
    messages: [],
    updatedAt: '',
    delivery: [
      { key: 's1', label: 'Build', state: 'done' as const, detail: 'Built successfully' },
      { key: 's2', label: 'Deploy', state: 'pending' as const, detail: 'Waiting' },
    ],
  };

  it('collapses the stages by default so the chat takes precedence', () => {
    render(
      <BranchChat
        branchId="branch-1"
        record={mockRecord}
        leaves={[]}
        messages={[]}
        onMessagesChange={vi.fn()}
        onProposals={vi.fn()}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onAcceptAll={vi.fn()}
      />
    );

    // Chat surface is immediately rendered
    expect(screen.getByTestId('chat-surface')).toBeInTheDocument();

    // Stages header is visible in collapsed state
    expect(screen.getByText('1 of 2 stages')).toBeInTheDocument();

    // The expanded delivery section is NOT in the document
    expect(screen.queryByTestId('delivery-stages')).not.toBeInTheDocument();
  });

  it('toggles stages expanded when the header button is clicked', () => {
    render(
      <BranchChat
        branchId="branch-1"
        record={mockRecord}
        leaves={[]}
        messages={[]}
        onMessagesChange={vi.fn()}
        onProposals={vi.fn()}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onAcceptAll={vi.fn()}
      />
    );

    const toggleBtn = screen.getByText('1 of 2 stages').closest('button')!;
    fireEvent.click(toggleBtn);

    // Delivery stages are now visible
    expect(screen.getByTestId('delivery-stages')).toBeInTheDocument();

    // Clicking again collapses
    fireEvent.click(toggleBtn);
    expect(screen.queryByTestId('delivery-stages')).not.toBeInTheDocument();
  });

  it('resets stages to collapsed when switching branches', () => {
    const { rerender } = render(
      <BranchChat
        branchId="branch-1"
        record={mockRecord}
        leaves={[]}
        messages={[]}
        onMessagesChange={vi.fn()}
        onProposals={vi.fn()}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onAcceptAll={vi.fn()}
      />
    );

    // Expand on branch-1
    const toggleBtn = screen.getByText('1 of 2 stages').closest('button')!;
    fireEvent.click(toggleBtn);
    expect(screen.getByTestId('delivery-stages')).toBeInTheDocument();

    // Switch to branch-2
    rerender(
      <BranchChat
        branchId="branch-2"
        record={{ ...mockRecord, id: 'branch-2' }}
        leaves={[]}
        messages={[]}
        onMessagesChange={vi.fn()}
        onProposals={vi.fn()}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onAcceptAll={vi.fn()}
      />
    );

    // Reset to collapsed on the new branch
    expect(screen.queryByTestId('delivery-stages')).not.toBeInTheDocument();
  });
});
