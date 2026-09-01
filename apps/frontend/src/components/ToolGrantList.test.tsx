import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ToolGrantList from './ToolGrantList';

const tools = [
  { name: 'get_logs', category: 'assistant', description: 'Read logs' },
  { name: 'list_clusters', category: 'assistant' },
  { name: 'web_search', category: 'web' },
];

const setup = (selected: string[] = []) => {
  const onChange = vi.fn();
  render(<ToolGrantList tools={tools} selected={selected} onChange={onChange} />);
  return { onChange };
};

describe('the overview', () => {
  it('shows every category at once, collapsed, with its grant count', () => {
    setup(['get_logs']);
    expect(screen.getByText('Project & Infra Tools')).toBeInTheDocument();
    expect(screen.getByText('Web & Search')).toBeInTheDocument();
    expect(screen.getByText('1/2')).toBeInTheDocument();
    expect(screen.getByText('0/1')).toBeInTheDocument();
  });

  it('renders no tool rows until a group is expanded', () => {
    setup();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText('get_logs')).not.toBeInTheDocument();
  });

  it('expands one group without touching the others', () => {
    setup();
    fireEvent.click(screen.getByLabelText('Expand Project & Infra Tools'));
    expect(screen.getByText('get_logs')).toBeInTheDocument();
    expect(screen.queryByText('web_search')).not.toBeInTheDocument();
  });

  it('collapses again', () => {
    setup();
    fireEvent.click(screen.getByLabelText('Expand Project & Infra Tools'));
    fireEvent.click(screen.getByLabelText('Collapse Project & Infra Tools'));
    expect(screen.queryByText('get_logs')).not.toBeInTheDocument();
  });

  it('says so when the registry is empty', () => {
    render(<ToolGrantList tools={[]} selected={[]} onChange={vi.fn()} />);
    expect(screen.getByText(/No tools in the registry/)).toBeInTheDocument();
  });
});

describe('granting by group', () => {
  it('grants a whole group from the overview, without expanding it', () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByLabelText('Grant all Project & Infra Tools tools'));
    expect(onChange).toHaveBeenCalledWith(['get_logs', 'list_clusters']);
    // Still collapsed — granting is not browsing.
    expect(screen.queryByText('get_logs')).not.toBeInTheDocument();
  });

  it('revokes a whole group once it is fully granted', () => {
    const { onChange } = setup(['get_logs', 'list_clusters']);
    fireEvent.click(screen.getByLabelText('Revoke all Project & Infra Tools tools'));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('fills a partly-granted group in rather than clearing it', () => {
    const { onChange } = setup(['get_logs']);
    fireEvent.click(screen.getByLabelText('Grant all Project & Infra Tools tools'));
    expect(onChange).toHaveBeenCalledWith(['get_logs', 'list_clusters']);
  });

  it('leaves other groups untouched', () => {
    const { onChange } = setup(['web_search']);
    fireEvent.click(screen.getByLabelText('Grant all Project & Infra Tools tools'));
    expect(onChange).toHaveBeenCalledWith(['web_search', 'get_logs', 'list_clusters']);
  });

  it('expanding a group does not change what it grants', () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByLabelText('Expand Project & Infra Tools'));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('granting one tool', () => {
  it('toggles a single grant inside an expanded group', () => {
    const { onChange } = setup(['get_logs']);
    fireEvent.click(screen.getByLabelText('Expand Project & Infra Tools'));
    fireEvent.click(screen.getByRole('checkbox', { name: /list_clusters/ }));
    expect(onChange).toHaveBeenCalledWith(['get_logs', 'list_clusters']);
  });

  it('reflects what is granted in the checkboxes', () => {
    setup(['get_logs']);
    fireEvent.click(screen.getByLabelText('Expand Project & Infra Tools'));
    expect(screen.getByRole('checkbox', { name: /get_logs/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /list_clusters/ })).not.toBeChecked();
  });
});
