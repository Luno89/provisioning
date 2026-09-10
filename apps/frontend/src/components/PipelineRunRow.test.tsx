import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PipelineRunRow, StatusBadge, type PipelineRun } from './PipelineRunRow';

const baseRun: PipelineRun = {
  id: 'run-1',
  projectId: 'proj-1',
  commitSha: 'abcdef1234',
  ref: 'main',
  status: 'succeeded',
  imageTag: 'registry.local/demo:abcdef1234',
  startedAt: '2026-01-01T00:00:00Z',
  finishedAt: '2026-01-01T00:01:30Z',
};

describe('StatusBadge', () => {
  it('labels each status distinctly', () => {
    render(<StatusBadge status="running" />);
    expect(screen.getByText('Building')).toBeInTheDocument();
  });

  it('falls back to Queued for an unknown status', () => {
    render(<StatusBadge status={undefined} />);
    expect(screen.getByText('Queued')).toBeInTheDocument();
  });
});

describe('PipelineRunRow', () => {
  it('shows a truncated first line of the commit message', () => {
    render(
      <PipelineRunRow
        run={{ ...baseRun, commitMessage: 'Fix the thing\n\nLonger body text nobody needs here' }}
        onViewLogs={vi.fn()}
      />,
    );
    expect(screen.getByText('Fix the thing')).toBeInTheDocument();
    expect(screen.queryByText(/Longer body text/)).not.toBeInTheDocument();
  });

  it('shows no commit-message line when the run has none', () => {
    render(<PipelineRunRow run={baseRun} onViewLogs={vi.fn()} />);
    expect(screen.queryByText(/^Fix/)).not.toBeInTheDocument();
  });

  it('shows the Live tag only when isLive is true', () => {
    const { rerender } = render(<PipelineRunRow run={baseRun} isLive onViewLogs={vi.fn()} />);
    expect(screen.getByText('● Live')).toBeInTheDocument();

    rerender(<PipelineRunRow run={baseRun} isLive={false} onViewLogs={vi.fn()} />);
    expect(screen.queryByText('● Live')).not.toBeInTheDocument();
  });

  it('calls onViewLogs with the run id', () => {
    const onViewLogs = vi.fn();
    render(<PipelineRunRow run={baseRun} onViewLogs={onViewLogs} />);
    fireEvent.click(screen.getByText('Build Logs'));
    expect(onViewLogs).toHaveBeenCalledWith('run-1');
  });

  it('only offers Deploy for a succeeded run with an image, and only when onPromote is given', () => {
    const succeeded = render(<PipelineRunRow run={baseRun} onViewLogs={vi.fn()} onPromote={vi.fn()} />);
    expect(succeeded.getByText('Deploy')).toBeInTheDocument();
    succeeded.unmount();

    const failed = render(
      <PipelineRunRow run={{ ...baseRun, status: 'failed' }} onViewLogs={vi.fn()} onPromote={vi.fn()} />,
    );
    expect(failed.queryByText('Deploy')).not.toBeInTheDocument();
  });

  it('calls onPromote with the run when Deploy is clicked', () => {
    const onPromote = vi.fn();
    render(<PipelineRunRow run={baseRun} onViewLogs={vi.fn()} onPromote={onPromote} />);
    fireEvent.click(screen.getByText('Deploy'));
    expect(onPromote).toHaveBeenCalledWith(baseRun);
  });
});
