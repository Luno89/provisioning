import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TreeTypes } from './index.js';
import * as groveApi from '../../api/grove.js';
import type { TreeType } from '../../types/grove.js';

vi.mock('../../api/grove.js', async (orig) => ({
  ...(await orig<typeof groveApi>()),
  listTreeTypes: vi.fn(),
  updateTreeType: vi.fn(),
}));

const treeType = (over: Partial<TreeType> = {}): TreeType => ({
  id: 'mcp-server',
  label: 'MCP server',
  summary: 'A service exposing tools over MCP.',
  language: 'node',
  produces: 'service',
  doneMeans: 'It builds and deploys.',
  files: [],
  ...over,
});

function renderPanel(types: TreeType[]) {
  vi.mocked(groveApi.listTreeTypes).mockResolvedValue(types);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TreeTypes />
    </QueryClientProvider>,
  );
}

describe('TreeTypes editor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists tree types and prompts to pick one before showing the editor', async () => {
    renderPanel([treeType()]);
    await waitFor(() => expect(screen.getByText('MCP server')).toBeInTheDocument());
    expect(screen.getByText(/pick a tree type/i)).toBeInTheDocument();
  });

  it('selecting a type shows every section on one continuous page, not behind tabs', async () => {
    renderPanel([treeType()]);
    await waitFor(() => expect(screen.getByText('MCP server')).toBeInTheDocument());
    fireEvent.click(screen.getByText('MCP server'));

    expect(await screen.findByDisplayValue('A service exposing tools over MCP.')).toBeInTheDocument();
    expect(screen.getByText('Scaffold')).toBeInTheDocument();
    expect(screen.getByText('Bindings')).toBeInTheDocument();
    expect(screen.queryByText('Validation recipe')).toBeNull();
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  });

  it('editing a field enables Save, and saving calls updateTreeType with the full record', async () => {
    const saved = treeType({ summary: 'Updated summary' });
    vi.mocked(groveApi.updateTreeType).mockResolvedValue(saved);
    renderPanel([treeType()]);

    await waitFor(() => expect(screen.getByText('MCP server')).toBeInTheDocument());
    fireEvent.click(screen.getByText('MCP server'));

    const summaryInput = await screen.findByDisplayValue('A service exposing tools over MCP.');
    fireEvent.change(summaryInput, { target: { value: 'Updated summary' } });

    const saveButton = screen.getByRole('button', { name: /save/i });
    expect(saveButton).not.toBeDisabled();
    fireEvent.click(saveButton);

    await waitFor(() => expect(groveApi.updateTreeType).toHaveBeenCalledWith(
      'mcp-server',
      expect.objectContaining({ id: 'mcp-server', summary: 'Updated summary' }),
    ));
    await waitFor(() => expect(screen.getByText('Saved.')).toBeInTheDocument());
  });

  it('creating a new tree type auto-derives the id slug from the label until the id is edited directly', async () => {
    renderPanel([treeType()]);
    await waitFor(() => expect(screen.getByText('MCP server')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /new tree type/i }));
    const idInput = screen.getByPlaceholderText('my-new-type');
    const labelInput = screen.getByPlaceholderText('My new type');

    fireEvent.change(labelInput, { target: { value: 'My Cool Type' } });
    expect(idInput).toHaveValue('my-cool-type');

    // Once the id is edited directly, further label edits stop overwriting it.
    fireEvent.change(idInput, { target: { value: 'custom-id' } });
    fireEvent.change(labelInput, { target: { value: 'Something Else' } });
    expect(idInput).toHaveValue('custom-id');
  });

  it('creating a tree type whose id collides with an existing one blocks Create', async () => {
    renderPanel([treeType({ id: 'mcp-server', label: 'MCP server' })]);
    await waitFor(() => expect(screen.getByText('MCP server')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /new tree type/i }));

    fireEvent.change(screen.getByPlaceholderText('my-new-type'), { target: { value: 'mcp-server' } });
    fireEvent.change(screen.getByPlaceholderText('My new type'), { target: { value: 'x' } });
    fireEvent.change(screen.getByPlaceholderText('One line describing what this produces'), { target: { value: 'x' } });

    expect(screen.getByText(/already uses this id/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create/i })).toBeDisabled();
  });

  it('refuses to enable Create until id, label, summary and doneMeans are filled', async () => {
    renderPanel([treeType()]);
    await waitFor(() => expect(screen.getByText('MCP server')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /new tree type/i }));

    const createButton = screen.getByRole('button', { name: /create/i });
    expect(createButton).toBeDisabled();
  });
});
