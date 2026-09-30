import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TreeTypes } from './index.js';
import * as groveApi from '../../api/grove.js';
import * as agentsApi from '../../api/agents.js';
import type { TreeType } from '../../types/grove.js';

vi.mock('../../api/grove.js', async (orig) => ({
  ...(await orig<typeof groveApi>()),
  listTreeTypes: vi.fn(),
  updateTreeType: vi.fn(),
}));

vi.mock('../../api/agents.js', async (orig) => ({
  ...(await orig<typeof agentsApi>()),
  listAgents: vi.fn(),
}));

const agent = (over: Partial<agentsApi.Agent> = {}): agentsApi.Agent => ({
  slug: 'leaf-worker',
  name: 'Leaf Worker',
  description: 'Carries a grove leaf\'s work.',
  version: '1',
  prompt: 'You are the structure of a grove leaf\'s work.',
  guidance: '',
  returns: '',
  failures: [],
  procedure: 'grove-work-leaf',
  tools: ['next_leaf_task'],
  environment: {},
  mine: false,
  ...over,
});

const AGENTS = [
  agent({ slug: 'planner', name: 'Planner', procedure: 'planning', tools: ['propose_plan'] }),
  agent(),
  agent({ slug: 'type-worker', name: 'Type Worker', mine: true }),
  agent({ slug: 'grove-runner', name: 'Grove Runner', procedure: 'grove-judge-pass', tools: ['ready_leaves'] }),
];

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
  vi.mocked(agentsApi.listAgents).mockResolvedValue(AGENTS);
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

  it('shows each stage with the agent it falls back to', async () => {
    renderPanel([treeType()]);
    await waitFor(() => expect(screen.getByText('MCP server')).toBeInTheDocument());
    fireEvent.click(screen.getByText('MCP server'));

    expect(await screen.findByLabelText('Agent for the plan stage')).toHaveValue('');
    expect(screen.getByText('plan — default, planner')).toBeInTheDocument();
    expect(screen.getByText('work — default, leaf-worker')).toBeInTheDocument();
    expect(screen.getByText('judge — default, grove-runner')).toBeInTheDocument();
  });

  it('names an agent for a stage, and saves that in stages', async () => {
    vi.mocked(groveApi.updateTreeType).mockResolvedValue(treeType({ stages: { work: 'type-worker' } }));
    renderPanel([treeType()]);
    await waitFor(() => expect(screen.getByText('MCP server')).toBeInTheDocument());
    fireEvent.click(screen.getByText('MCP server'));

    // The options come with the agents query; changing the select before they land would not stick.
    const work = await screen.findByLabelText('Agent for the work stage');
    await waitFor(() => expect(work.querySelectorAll('option')).toHaveLength(AGENTS.length + 1));
    fireEvent.change(work, { target: { value: 'type-worker' } });
    expect(screen.getByText('work — type-worker')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(groveApi.updateTreeType).toHaveBeenCalledWith(
      'mcp-server',
      expect.objectContaining({ stages: { work: 'type-worker' } }),
    ));
  });

  it('links the agent a stage runs to its procedure in the Studio', async () => {
    renderPanel([treeType({ stages: { work: 'type-worker' } })]);
    await waitFor(() => expect(screen.getByText('MCP server')).toBeInTheDocument());
    fireEvent.click(screen.getByText('MCP server'));

    const link = await screen.findByRole('link', { name: /open grove-work-leaf/i });
    expect(link).toHaveAttribute('href', '#/studio/grove-work-leaf');
  });

  it('leaves a stage out of the record when it is put back to its default', async () => {
    vi.mocked(groveApi.updateTreeType).mockResolvedValue(treeType());
    renderPanel([treeType({ stages: { work: 'type-worker' } })]);
    await waitFor(() => expect(screen.getByText('MCP server')).toBeInTheDocument());
    fireEvent.click(screen.getByText('MCP server'));

    fireEvent.change(await screen.findByLabelText('Agent for the work stage'), { target: { value: '' } });
    expect(screen.getByText('work — default, leaf-worker')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(groveApi.updateTreeType).toHaveBeenCalledWith(
      'mcp-server',
      expect.objectContaining({ stages: undefined }),
    ));
  });
});
