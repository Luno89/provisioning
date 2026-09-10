import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TreeTypes } from './index.js';
import * as groveApi from '../../api/grove.js';
import * as packsApi from '../../api/packs.js';
import * as customStepsApi from '../../api/custom-steps.js';
import type { TreeType, CustomStepDefinition } from '../../types/grove.js';

vi.mock('../../api/grove.js', async (orig) => ({
  ...(await orig<typeof groveApi>()),
  listTreeTypes: vi.fn(),
  updateTreeType: vi.fn(),
}));

vi.mock('../../api/packs.js', async (orig) => ({
  ...(await orig<typeof packsApi>()),
  listPacks: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../api/custom-steps.js', async (orig) => ({
  ...(await orig<typeof customStepsApi>()),
  listCustomSteps: vi.fn().mockResolvedValue([]),
  createCustomStep: vi.fn(),
  updateCustomStep: vi.fn(),
  deleteCustomStep: vi.fn(),
}));

const treeType = (over: Partial<TreeType> = {}): TreeType => ({
  id: 'mcp-server',
  label: 'MCP server',
  summary: 'A service exposing tools over MCP.',
  language: 'node',
  produces: 'service',
  doneMeans: 'It builds and deploys.',
  files: [],
  validationRecipe: { type: 'runtime-service', checks: [] },
  ...over,
});

function renderPanel(types: TreeType[], customSteps: CustomStepDefinition[] = []) {
  vi.mocked(groveApi.listTreeTypes).mockResolvedValue(types);
  vi.mocked(customStepsApi.listCustomSteps).mockResolvedValue(customSteps);
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
    // All section headings visible at once — no tab click needed to reach them.
    expect(screen.getByText('Scaffold')).toBeInTheDocument();
    expect(screen.getByText('Validation recipe')).toBeInTheDocument();
    expect(screen.getByText('Bindings')).toBeInTheDocument();
    expect(screen.getByText('Roles')).toBeInTheDocument();
    expect(screen.getByText('Auto-accept')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled(); // unmodified draft
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

  it('adding a validation step enables Save without switching views', async () => {
    renderPanel([treeType()]);
    await waitFor(() => expect(screen.getByText('MCP server')).toBeInTheDocument());
    fireEvent.click(screen.getByText('MCP server'));
    await screen.findByDisplayValue('A service exposing tools over MCP.');

    expect(screen.getByText(/no steps yet/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /add step/i }));
    expect(screen.queryByText(/no steps yet/i)).toBeNull();
    expect(screen.getByRole('button', { name: /save/i })).not.toBeDisabled();
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

  it('shows the custom step types panel, collapsed by default', async () => {
    renderPanel([treeType()]);
    await waitFor(() => expect(screen.getByText('Custom step types')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /new custom step type/i })).toBeNull();

    fireEvent.click(screen.getByText('Custom step types'));
    expect(await screen.findByRole('button', { name: /new custom step type/i })).toBeInTheDocument();
  });
});
