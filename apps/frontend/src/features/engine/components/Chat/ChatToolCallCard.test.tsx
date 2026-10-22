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

describe('a hand-off\'s card', () => {
  it('shows what the run it started is doing while it works', () => {
    render(<ChatToolCallCard tool={{
      id: 'c1', name: 'research', running: true,
      child: { runId: 'r1', agentId: 'research', running: true, live: 'Postgres listens on 5432', tools: [{ id: 'x1', name: 'search_web', args: '{}', running: false, ok: true }] },
    }} />);

    expect(screen.getByText('working — 1 step so far')).toBeInTheDocument();
    expect(screen.getByText('search_web')).toBeInTheDocument();
    expect(screen.getByText('Postgres listens on 5432')).toBeInTheDocument();
  });

  it('folds a finished run\'s steps away, and opens them again from what was stored', () => {
    render(<ChatToolCallCard tool={{
      id: 'c1', name: 'research', ok: true, digest: 'found it',
      child: { runId: 'r1', agentId: 'research', outcome: 'ok', steps: [{ callId: 'x1', name: 'write_file', ok: true, digest: 'wrote findings.md' }, { callId: 'x2', name: 'fetch_web_page', ok: false }] },
    }} />);

    expect(screen.getByText('finished — 2 steps')).toBeInTheDocument();
    expect(screen.queryByText('write_file')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('finished — 2 steps'));
    expect(screen.getByText('write_file')).toBeInTheDocument();
    expect(screen.getByText('fetch_web_page')).toBeInTheDocument();
  });

  it('says why a run that did not finish stopped', () => {
    render(<ChatToolCallCard tool={{ id: 'c1', name: 'research', ok: false, digest: 'x', child: { runId: 'r1', agentId: 'research', outcome: 'failed', reason: 'no source answered it', steps: [] } }} />);

    expect(screen.getByText('did not finish: no source answered it — 0 steps')).toBeInTheDocument();
  });
});
