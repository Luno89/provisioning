import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import ChatToolCallCard from './ChatToolCallCard.js';

describe('ChatToolCallCard — Hermes-style tool telemetry', () => {
  it('renders tool name and running indicator when active', () => {
    render(<ChatToolCallCard tool={{ id: 't1', name: 'cluster_capacity', running: true }} />);
    expect(screen.getByText('cluster_capacity')).toBeInTheDocument();
    expect(screen.getByText(/running/i)).toBeInTheDocument();
  });

  it('renders completed tool with expandable arguments and digest output', () => {
    render(
      <ChatToolCallCard
        tool={{
          id: 't2',
          name: 'get_logs',
          args: '{"pod":"core-api"}',
          ok: true,
          digest: 'Application started on port 3000',
        }}
      />
    );

    expect(screen.getByText('get_logs')).toBeInTheDocument();
    expect(screen.getByText(/completed/i)).toBeInTheDocument();

    // Click to open details
    fireEvent.click(screen.getByText('get_logs'));

    expect(screen.getByText('{"pod":"core-api"}')).toBeInTheDocument();
    expect(screen.getByText('Application started on port 3000')).toBeInTheDocument();
  });
});
