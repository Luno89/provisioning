import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PersonaConfigDrawer from './PersonaConfigDrawer.js';
import * as personasApi from '../api/personas.js';

vi.mock('../api/personas', async (orig) => ({
  ...(await orig<typeof personasApi>()),
  listPersonas: vi.fn(),
  getPersonaOptions: vi.fn(),
  updatePersona: vi.fn(),
}));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

describe('PersonaConfigDrawer — in-chat persona tuning and tool matrix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockPersonas = [
    {
      id: 'p-koala',
      name: 'Koala',
      description: 'General Builder',
      systemPrompt: 'You are Koala.',
      scope: {
        tools: ['propose_tree', 'get_logs'],
        mcp: ['github-mcp'],
        run: { maxSteps: 20 },
      },
      overrides: { temperature: 0.7 },
    },
    {
      id: 'p-researcher',
      name: 'Researcher',
      description: 'Deep Analyst',
      systemPrompt: 'You are Researcher.',
      scope: { tools: [], mcp: [] },
      overrides: { temperature: 0.2 },
    },
  ];

  const mockOptions = {
    languages: ['typescript', 'python'],
    images: ['node:20', 'python:3.11'],
    tools: ['propose_tree', 'get_logs', 'list_infrastructure'],
    mcpServers: [{ name: 'github-mcp', toolCount: 4 }],
  };

  it('renders persona drawer when open and displays persona list and tools', async () => {
    vi.mocked(personasApi.listPersonas).mockResolvedValue(mockPersonas as any);
    vi.mocked(personasApi.getPersonaOptions).mockResolvedValue(mockOptions as any);

    render(
      <QueryClientProvider client={queryClient}>
        <PersonaConfigDrawer
          isOpen={true}
          onClose={vi.fn()}
          activePackId="p-koala"
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

  it('saves persona updates when clicking Save Configuration', async () => {
    vi.mocked(personasApi.listPersonas).mockResolvedValue(mockPersonas as any);
    vi.mocked(personasApi.getPersonaOptions).mockResolvedValue(mockOptions as any);
    vi.mocked(personasApi.updatePersona).mockResolvedValue({ ...mockPersonas[0] } as any);

    render(
      <QueryClientProvider client={queryClient}>
        <PersonaConfigDrawer
          isOpen={true}
          onClose={vi.fn()}
          activePackId="p-koala"
          onSelectPack={vi.fn()}
        />
      </QueryClientProvider>
    );

    await waitFor(() => expect(screen.getByText('Koala')).toBeInTheDocument());

    const saveBtn = screen.getByRole('button', { name: /save configuration/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(personasApi.updatePersona).toHaveBeenCalledWith(
        'p-koala',
        expect.objectContaining({
          name: 'Koala',
          systemPrompt: 'You are Koala.',
        }),
      );
    });
  });
});
