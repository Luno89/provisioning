import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TreeTypes } from './index.js';
import * as groveApi from '../../api/grove.js';
import type { TreeType } from '../../types/grove.js';

const params = vi.hoisted(() => ({ typeId: undefined as string | undefined, part: undefined as string | undefined }));
const seen = vi.hoisted(() => ({ props: {} as Record<string, unknown> }));

vi.mock('@tanstack/react-router', () => ({
  useParams: () => params,
  useNavigate: () => vi.fn(),
  Link: ({ children, to, params: linked }: { children: React.ReactNode; to: string; params?: Record<string, string> }) =>
    <a href={Object.entries(linked ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to)}>{children}</a>,
}));

vi.mock('./TreeTypeEditor.js', () => ({ TreeTypeEditor: (props: Record<string, unknown>) => { seen.props = props; return <div data-testid="editor" />; } }));

vi.mock('../../api/grove.js', async (orig) => ({ ...(await orig<typeof groveApi>()), listTreeTypes: vi.fn() }));

const treeType = (over: Partial<TreeType>): TreeType => ({ id: 'mcp-server', label: 'MCP server', summary: '', language: 'node', produces: 'service', doneMeans: '', files: [], ...over });

const show = () => {
  vi.mocked(groveApi.listTreeTypes).mockResolvedValue([treeType({}), treeType({ id: 'research-paper', label: 'Research paper', produces: 'artefact' })]);
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TreeTypes /></QueryClientProvider>);
};

const tree = () => within(screen.getByRole('complementary', { name: 'Tree Types' }));

beforeEach(() => {
  seen.props = {};
  params.typeId = undefined;
  params.part = undefined;
});

describe('the tree types explorer', () => {
  it('groups tree types by what they make', async () => {
    show();
    expect(await tree().findByText('Build something that runs')).toBeInTheDocument();
    expect(tree().getByText('Produce a document or artefact')).toBeInTheDocument();
    expect(tree().getByText('Research paper').closest('a')).toHaveAttribute('href', '/studio/tree-types/research-paper');
  });

  it('opens a type on its overview, and each part on its own', async () => {
    params.typeId = 'mcp-server';
    show();
    expect(await screen.findByTestId('editor')).toBeInTheDocument();
    expect(seen.props).toMatchObject({ type: { id: 'mcp-server' }, only: 'overview' });
  });

  it('opens one part of it', async () => {
    params.typeId = 'mcp-server';
    params.part = 'scaffold';
    show();
    await screen.findByTestId('editor');
    expect(seen.props).toMatchObject({ only: 'scaffold' });
    expect(screen.getByRole('navigation', { name: 'Path' })).toHaveTextContent('Tree TypesMCP serverScaffold');
  });

  it('starts a new tree type from a name', async () => {
    show();
    await tree().findByText('MCP server');
    await userEvent.click(screen.getByRole('button', { name: 'New tree type' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Name of the new tree type' }), 'Game Server{Enter}');
    expect(seen.props).toMatchObject({ type: undefined, initialLabel: 'Game Server' });
  });
});
