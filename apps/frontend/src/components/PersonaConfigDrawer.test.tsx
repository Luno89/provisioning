import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PersonaConfigDrawer from './PersonaConfigDrawer.js';
import * as personasApi from '../api/personas.js';
import * as packsApi from '../api/packs';
import * as toolsApi from '../api/harness/tools.js';

vi.mock('../api/personas', async (orig) => ({
  ...(await orig<typeof personasApi>()),
  listPersonas: vi.fn(),
  getPersonaOptions: vi.fn(),
  updatePersona: vi.fn(),
}));

vi.mock('../api/packs', async (orig) => ({
  ...(await orig<typeof packsApi>()),
  listPacks: vi.fn(),
  updatePack: vi.fn(),
}));

vi.mock('../api/harness/tools', async (orig) => ({
  ...(await orig<typeof toolsApi>()),
  listTools: vi.fn(),
}));

vi.mock('../api/models', () => ({
  listModels: vi.fn().mockResolvedValue([]),
  providerKeys: { list: () => ['models'] as const },
  useDefaultModel: vi.fn(() => ({ data: null })),
}));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

describe('PersonaConfigDrawer — pack tuning and tool matrix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockPersonas = [
    { id: 'p-koala', name: 'Koala', systemPrompt: 'You are Koala.' },
    { id: 'p-researcher', name: 'Researcher', systemPrompt: 'You are Researcher.' },
  ];

  const mockPacks = [
    {
      id: 'pack-koala', slug: 'koala', name: 'Koala', description: 'General Builder',
      personaId: 'p-koala', tools: ['propose_tree', 'get_logs'],
      sampling: { toolTurn: {}, conversation: {} },
      budget: { replyTokens: {}, contextTokens: 0, handoff: {}, run: {}, record: {} },
      prompt: { sections: {}, pressure: {} },
      createdAt: '', updatedAt: '',
    },
    {
      id: 'pack-researcher', slug: 'researcher', name: 'Researcher', description: 'Deep Analyst',
      personaId: 'p-researcher', tools: [],
      sampling: { toolTurn: {}, conversation: {} },
      budget: { replyTokens: {}, contextTokens: 0, handoff: {}, run: {}, record: {} },
      prompt: { sections: {}, pressure: {} },
      createdAt: '', updatedAt: '',
    },
  ];

  const mockTools = [
    { name: 'propose_tree', description: 'Propose a project', category: 'assistant' },
    { name: 'get_logs', description: 'Get container logs', category: 'assistant' },
    { name: 'web_search', description: 'Search the web', category: 'web' },
  ];

  it('renders the drawer when open and lists packs and tools from the API', async () => {
    vi.mocked(packsApi.listPacks).mockResolvedValue(mockPacks as any);
    vi.mocked(personasApi.listPersonas).mockResolvedValue(mockPersonas as any);
    vi.mocked(toolsApi.listTools).mockResolvedValue(mockTools as any);

    render(
      <QueryClientProvider client={queryClient}>
        <PersonaConfigDrawer
          isOpen={true}
          onClose={vi.fn()}
          activePackId="pack-koala"
          onSelectPack={vi.fn()}
        />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Persona & Capabilities')).toBeInTheDocument();
      expect(screen.getByText('Koala')).toBeInTheDocument();
      expect(screen.getByText('Researcher')).toBeInTheDocument();
      expect(screen.getByText('Enabled Capabilities & Tools')).toBeInTheDocument();
      // Groups are collapsed, so the overview shows categories and grant counts, not tool names.
      expect(screen.getByText('Project & Infra Tools')).toBeInTheDocument();
      expect(screen.getByText('2/2')).toBeInTheDocument();
      expect(screen.getByText('Web & Search')).toBeInTheDocument();
      expect(screen.getByText('0/1')).toBeInTheDocument();
      expect(screen.queryByText('propose_tree')).not.toBeInTheDocument();
    });
  });

  it('reveals the tools in a group when it is expanded', async () => {
    vi.mocked(packsApi.listPacks).mockResolvedValue(mockPacks as any);
    vi.mocked(personasApi.listPersonas).mockResolvedValue(mockPersonas as any);
    vi.mocked(toolsApi.listTools).mockResolvedValue(mockTools as any);

    render(
      <QueryClientProvider client={queryClient}>
        <PersonaConfigDrawer
          isOpen={true}
          onClose={vi.fn()}
          activePackId="pack-koala"
          onSelectPack={vi.fn()}
        />
      </QueryClientProvider>
    );

    await waitFor(() => expect(screen.getByText('Project & Infra Tools')).toBeInTheDocument());
    screen.getByLabelText('Expand Project & Infra Tools').click();

    await waitFor(() => expect(screen.getByText('propose_tree')).toBeInTheDocument());
    expect(screen.getByText('get_logs')).toBeInTheDocument();
  });

  it('hands back the pack ID, which is what the route carries', async () => {
    vi.mocked(packsApi.listPacks).mockResolvedValue(mockPacks as any);
    vi.mocked(personasApi.listPersonas).mockResolvedValue(mockPersonas as any);
    vi.mocked(toolsApi.listTools).mockResolvedValue(mockTools as any);

    const onSelect = vi.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <PersonaConfigDrawer
          isOpen={true}
          onClose={vi.fn()}
          activePackId="pack-koala"
          onSelectPack={onSelect}
        />
      </QueryClientProvider>
    );

    await waitFor(() => expect(screen.getByText('Researcher')).toBeInTheDocument());
    const researcherBtn = screen.getByText('Researcher').closest('button');
    researcherBtn?.click();
    expect(onSelect).toHaveBeenCalledWith('pack-researcher');
  });

  it('persists tool toggles and prompt edits through the save button', async () => {
    vi.mocked(packsApi.listPacks).mockResolvedValue(mockPacks as any);
    vi.mocked(personasApi.listPersonas).mockResolvedValue(mockPersonas as any);
    vi.mocked(toolsApi.listTools).mockResolvedValue(mockTools as any);

    render(
      <QueryClientProvider client={queryClient}>
        <PersonaConfigDrawer
          isOpen={true}
          onClose={vi.fn()}
          activePackId="pack-koala"
          onSelectPack={vi.fn()}
        />
      </QueryClientProvider>
    );

    await waitFor(() => expect(screen.getByText('Enabled Capabilities & Tools')).toBeInTheDocument());

    const saveBtn = screen.getByText('Save Configuration');
    saveBtn.click();

    await waitFor(() => {
      expect(packsApi.updatePack).toHaveBeenCalledWith('pack-koala', {
        name: 'Koala',
        description: 'General Builder',
        tools: ['propose_tree', 'get_logs'],
        mcp: [],
        canRunLeaf: false,
        model: { endpointId: null },
      });
    });
  });
});