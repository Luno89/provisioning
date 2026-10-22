import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TreeTypeEditor, type TreeTypeSection } from './TreeTypeEditor.js';
import * as groveApi from '../../api/grove.js';
import * as agentsApi from '../../../../api/agents.js';
import type { TreeType } from '../../types/grove.js';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

vi.mock('../../api/grove.js', async (orig) => ({
  ...(await orig<typeof groveApi>()),
  listTreeTypes: vi.fn(),
  updateTreeType: vi.fn(),
}));

vi.mock('../../../../api/agents.js', async (orig) => ({
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
  agent({ slug: 'grove', name: 'Grove', procedure: 'grove-run', tools: [] }),
  agent({ slug: 'grove-paper', name: 'Grove Paper', procedure: 'grove-paper-run', tools: [] }),
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

function renderEditor(type: TreeType | undefined, types: TreeType[] = [treeType()], only?: TreeTypeSection, initialLabel?: string) {
  vi.mocked(agentsApi.listAgents).mockResolvedValue(AGENTS);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TreeTypeEditor type={type} types={types} only={only} initialLabel={initialLabel} />
    </QueryClientProvider>,
  );
}

describe('editing a tree type', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows every section together when nothing narrows it, and only the one asked for when something does', async () => {
    renderEditor(treeType());
    expect(await screen.findByDisplayValue('A service exposing tools over MCP.')).toBeInTheDocument();
    expect(screen.getByText('Scaffold')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Depends on' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  });

  it('shows one section on its own', () => {
    renderEditor(treeType(), [treeType()], 'bindings');
    expect(screen.getByText('Depends on')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Depends on' })).toBeNull();
    expect(screen.queryByText('Scaffold')).toBeNull();
    expect(screen.queryByDisplayValue('A service exposing tools over MCP.')).toBeNull();
  });

  it('editing a field enables Save, and saving calls updateTreeType with the full record', async () => {
    vi.mocked(groveApi.updateTreeType).mockResolvedValue(treeType({ summary: 'Updated summary' }));
    renderEditor(treeType());

    fireEvent.change(await screen.findByDisplayValue('A service exposing tools over MCP.'), { target: { value: 'Updated summary' } });
    const saveButton = screen.getByRole('button', { name: /save/i });
    expect(saveButton).not.toBeDisabled();
    fireEvent.click(saveButton);

    await waitFor(() => expect(groveApi.updateTreeType).toHaveBeenCalledWith('mcp-server', expect.objectContaining({ id: 'mcp-server', summary: 'Updated summary' })));
    await waitFor(() => expect(screen.getByText('Saved.')).toBeInTheDocument());
  });

  it('a new tree type starts from the name it was given, and derives the id from the label until the id is edited directly', () => {
    renderEditor(undefined, [treeType()], undefined, 'My Cool Type');
    const idInput = screen.getByPlaceholderText('my-new-type');
    const labelInput = screen.getByPlaceholderText('My new type');
    expect(idInput).toHaveValue('my-cool-type');

    fireEvent.change(labelInput, { target: { value: 'Other Type' } });
    expect(idInput).toHaveValue('other-type');
    fireEvent.change(idInput, { target: { value: 'custom-id' } });
    fireEvent.change(labelInput, { target: { value: 'Something Else' } });
    expect(idInput).toHaveValue('custom-id');
  });

  it('creating a tree type whose id collides with an existing one blocks Create', () => {
    renderEditor(undefined, [treeType({ id: 'mcp-server', label: 'MCP server' })]);
    fireEvent.change(screen.getByPlaceholderText('my-new-type'), { target: { value: 'mcp-server' } });
    fireEvent.change(screen.getByPlaceholderText('My new type'), { target: { value: 'x' } });
    fireEvent.change(screen.getByPlaceholderText('One line describing what this produces'), { target: { value: 'x' } });

    expect(screen.getByText(/already uses this id/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create/i })).toBeDisabled();
  });

  it('refuses to enable Create until id, label, summary and doneMeans are filled', () => {
    renderEditor(undefined);
    expect(screen.getByRole('button', { name: /create/i })).toBeDisabled();
  });

  it('declares a secret the app needs from the vault, where it comes from and who it signs in as, and saves it', async () => {
    vi.mocked(groveApi.updateTreeType).mockImplementation(async (_id, saved) => saved as TreeType);
    renderEditor(treeType(), [treeType()], 'secrets');

    fireEvent.click(screen.getByRole('button', { name: /add secret/i }));
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'admin_password' } });
    fireEvent.change(screen.getByLabelText('Comes from'), { target: { value: 'generated' } });
    fireEvent.change(screen.getByLabelText('What it is for'), { target: { value: 'The admin password.' } });
    fireEvent.change(screen.getByLabelText('Signs in as'), { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(groveApi.updateTreeType).toHaveBeenCalledWith('mcp-server', expect.objectContaining({
      secrets: [{ key: 'ADMIN_PASSWORD', source: 'generated', describe: 'The admin password.', signInAs: 'admin' }],
    })));
  });

  it('leaves out who a secret signs in as once that is cleared', async () => {
    vi.mocked(groveApi.updateTreeType).mockImplementation(async (_id, saved) => saved as TreeType);
    renderEditor(treeType({ secrets: [{ key: 'A', source: 'person', describe: 'x', signInAs: 'admin' }] }), [treeType()], 'secrets');
    fireEvent.change(screen.getByLabelText('Signs in as'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(groveApi.updateTreeType).toHaveBeenCalledWith('mcp-server', expect.objectContaining({ secrets: [{ key: 'A', source: 'person', describe: 'x' }] })));
  });

  it('says the grove agent grows a type that names none', async () => {
    renderEditor(treeType(), [treeType()], 'grown-by');
    expect(await screen.findByLabelText('Agent that grows trees of this type')).toHaveValue('');
    expect(screen.getByText('grove, the default')).toBeInTheDocument();
  });

  it('names the agent that grows its trees, and saves it', async () => {
    vi.mocked(groveApi.updateTreeType).mockResolvedValue(treeType({ agent: 'grove-paper' }));
    renderEditor(treeType(), [treeType()], 'grown-by');

    const agent = await screen.findByLabelText('Agent that grows trees of this type');
    await waitFor(() => expect(agent.querySelectorAll('option')).toHaveLength(AGENTS.length + 1));
    fireEvent.change(agent, { target: { value: 'grove-paper' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(groveApi.updateTreeType).toHaveBeenCalledWith('mcp-server', expect.objectContaining({ agent: 'grove-paper' })));
  });

  it('links the agent to its procedure in the Studio, where its stages and limits are', async () => {
    renderEditor(treeType({ agent: 'grove-paper' }), [treeType()], 'grown-by');
    const link = await screen.findByRole('link', { name: /open grove-paper-run/i });
    expect(link).toHaveAttribute('href', '#/studio/procedures/grove-paper-run');
  });

  it('leaves the agent out of the record when it is put back to the default', async () => {
    vi.mocked(groveApi.updateTreeType).mockResolvedValue(treeType());
    renderEditor(treeType({ agent: 'grove-paper' }), [treeType()], 'grown-by');

    fireEvent.change(await screen.findByLabelText('Agent that grows trees of this type'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(groveApi.updateTreeType).toHaveBeenCalledWith('mcp-server', expect.objectContaining({ agent: undefined })));
  });
});

describe('the paths a type is released from', () => {
  it('takes one path per line, lets a new line be started, and saves the list', async () => {
    vi.mocked(groveApi.updateTreeType).mockImplementation(async (_id, saved) => saved as TreeType);
    renderEditor(treeType(), [treeType()], 'scaffold');
    const box = screen.getByLabelText('Released when these change');
    fireEvent.change(box, { target: { value: 'src/**\n' } });
    expect(box).toHaveValue('src/**\n');
    fireEvent.change(box, { target: { value: 'src/**\nDockerfile' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(groveApi.updateTreeType).toHaveBeenCalledWith('mcp-server', expect.objectContaining({ releaseWhen: ['src/**', 'Dockerfile'] })));
  });
});
