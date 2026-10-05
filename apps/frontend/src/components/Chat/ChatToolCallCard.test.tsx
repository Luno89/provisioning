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

    fireEvent.click(screen.getByText('get_logs'));

    expect(screen.getByText('{"pod":"core-api"}')).toBeInTheDocument();
    expect(screen.getByText('Application started on port 3000')).toBeInTheDocument();
  });
});

describe('ChatToolCallCard — what a tool made', () => {
  const research = {
    id: 't9',
    name: 'research',
    ok: true,
    digest: 'found it',
    artifacts: [
      { kind: 'file' as const, workspace: 'conversation-c1', path: 'research/r1/findings.md' },
      { kind: 'link' as const, url: 'https://example.com/app', title: 'the app' },
    ],
  };

  it('lists each file without opening the card, and opens the one clicked', () => {
    const opened: unknown[] = [];
    render(<ChatToolCallCard tool={research} onOpenDocument={(file) => opened.push(file)} />);

    fireEvent.click(screen.getByRole('button', { name: /research\/r1\/findings\.md/ }));

    expect(opened).toEqual([{ kind: 'file', workspace: 'conversation-c1', path: 'research/r1/findings.md' }]);
  });

  it('links a link to where it points, in a new tab', () => {
    render(<ChatToolCallCard tool={research} onOpenDocument={() => undefined} />);
    const link = screen.getByRole('link', { name: 'the app' });
    expect(link).toHaveAttribute('href', 'https://example.com/app');
    expect(link).toHaveAttribute('target', '_blank');
  });
});
