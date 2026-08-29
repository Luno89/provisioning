import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PersonaConfigDrawer from './PersonaConfigDrawer.js';
import * as personasApi from '../api/personas.js';
import * as packsApi from '../api/packs';

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

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

describe('PersonaConfigDrawer — pack tuning and tool matrix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockPersonas = [
    { id: 'p-koala', name: 'Koala', systemPrompt: 'You are Koala.', scope: { mcp: ['github-mcp'] }, overrides: {} },
    { id: 'p-researcher', name: 'Researcher', systemPrompt: 'You are Researcher.', scope: {}, overrides: {} },
  ];

  const mockPacks = [
    {
      id: 'pack-koala', slug: 'koala', name: 'Koala', description: 'General Builder',
      personaId: 'p-koala', toolset: 'assistant',
      tools: ['propose_tree', 'get_logs'], permitted: ['read', 'write', 'propose'],
      overrides: { temperature: 0.7, maxSteps: 20 },
    },
    {
      id: 'pack-researcher', slug: 'researcher', name: 'Researcher', description: 'Deep Analyst',
      personaId: 'p-researcher', toolset: 'assistant',
      tools: [], permitted: ['read'], overrides: { temperature: 0.2 },
    },
  ];

  const mockOptions = {
    languages: ['typescript', 'python'],
    images: ['node:20', 'python:3.11'],
    tools: ['propose_tree', 'get_logs', 'list_infrastructure'],
    mcpServers: [{ name: 'github-mcp', toolCount: 4 }],
  };

  it('renders the drawer when open and lists the packs and their tools', async () => {
    vi.mocked(packsApi.listPacks).mockResolvedValue(mockPacks as any);
    vi.mocked(personasApi.listPersonas).mockResolvedValue(mockPersonas as any);
    vi.mocked(personasApi.getPersonaOptions).mockResolvedValue(mockOptions as any);

    render(
      <QueryClientProvider client={queryClient}>
        <PersonaConfigDrawer
          isOpen={true}
          onClose={vi.fn()}
          activePackId="koala"
          onSelectPack={vi.fn()}
        />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Persona & Capabilities')).toBeInTheDocument();
      expect(screen.getByText('Koala')).toBeInTheDocument();
      expect(screen.getByText('Researcher')).toBeInTheDocument();
      expect(screen.getByText('Enabled Capabilities & Tools')).toBeInTheDocument();
    });
  });

  it('hands back the pack SLUG, which is what the route carries', async () => {
    const onSelectPack = vi.fn();
    vi.mocked(packsApi.listPacks).mockResolvedValue(mockPacks as any);
    vi.mocked(personasApi.listPersonas).mockResolvedValue(mockPersonas as any);
    vi.mocked(personasApi.getPersonaOptions).mockResolvedValue(mockOptions as any);

    render(
      <QueryClientProvider client={queryClient}>
        <PersonaConfigDrawer isOpen onClose={vi.fn()} activePackId="koala" onSelectPack={onSelectPack} />
      </QueryClientProvider>
    );

    await waitFor(() => expect(screen.getByText('Researcher')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Researcher'));

    expect(onSelectPack).toHaveBeenCalledWith('researcher');
    expect(onSelectPack).not.toHaveBeenCalledWith('pack-researcher');
  });

  it('saves the tool grant to the PACK, which is the record a chat turn reads', async () => {
    vi.mocked(packsApi.listPacks).mockResolvedValue(mockPacks as any);
    vi.mocked(packsApi.updatePack).mockResolvedValue(mockPacks[0] as any);
    vi.mocked(personasApi.listPersonas).mockResolvedValue(mockPersonas as any);
    vi.mocked(personasApi.getPersonaOptions).mockResolvedValue(mockOptions as any);
    vi.mocked(personasApi.updatePersona).mockResolvedValue({ ...mockPersonas[0] } as any);

    render(
      <QueryClientProvider client={queryClient}>
        <PersonaConfigDrawer
          isOpen={true}
          onClose={vi.fn()}
          activePackId="koala"
          onSelectPack={vi.fn()}
        />
      </QueryClientProvider>
    );

    await waitFor(() => expect(screen.getByText('Koala')).toBeInTheDocument());

    const saveBtn = screen.getByRole('button', { name: /save configuration/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(packsApi.updatePack).toHaveBeenCalledWith(
        'pack-koala',
        expect.objectContaining({
          name: 'Koala',
          tools: ['propose_tree', 'get_logs'],
          overrides: expect.objectContaining({ temperature: 0.7 }),
        }),
      );
    });
    expect(personasApi.updatePersona).not.toHaveBeenCalled();
  });
});
