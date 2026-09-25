import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import BranchHistory from './BranchHistory.js';

vi.mock('./AcceptancePlan.js', () => ({
  default: () => <div data-testid="acceptance-plan">AcceptancePlan Mock</div>,
}));

vi.mock('./Delivery.js', () => ({
  default: () => <div data-testid="delivery-stages">Delivery Mock</div>,
}));

const record = {
  id: 'branch-1',
  title: 'Test Branch',
  messages: [
    { role: 'user' as const, content: 'make it faster' },
    { role: 'assistant' as const, content: 'Leaf failed and will not be retried.', notice: true },
  ],
  updatedAt: '',
  delivery: [
    { key: 's1', label: 'Build', state: 'done' as const, detail: 'Built successfully' },
    { key: 's2', label: 'Deploy', state: 'pending' as const, detail: 'Waiting' },
  ],
};

describe('BranchHistory', () => {
  it('shows what was said, read-only, and says where new work starts', () => {
    render(<BranchHistory record={record} />);

    expect(screen.getByText('make it faster')).toBeInTheDocument();
    expect(screen.getByText(/Leaf failed and will not be retried/)).toBeInTheDocument();
    expect(screen.getByText(/History from the old pipeline, kept read-only/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('keeps the stages collapsed until asked', () => {
    render(<BranchHistory record={record} />);

    expect(screen.getByText('1 of 2 stages')).toBeInTheDocument();
    expect(screen.queryByTestId('delivery-stages')).not.toBeInTheDocument();
    const toggle = screen.getByText('1 of 2 stages').closest('button')!;
    fireEvent.click(toggle);
    expect(screen.getByTestId('delivery-stages')).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByTestId('delivery-stages')).not.toBeInTheDocument();
  });
});
