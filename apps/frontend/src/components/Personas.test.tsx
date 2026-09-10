import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Personas from './Personas.js';
import * as personasApi from '../api/personas.js';
import * as groveApi from '../api/grove.js';
import * as packsApi from '../api/packs.js';

vi.mock('../api/personas.js', async (orig) => ({
  ...(await orig<typeof personasApi>()),
  listPersonas: vi.fn(),
  deletePersona: vi.fn(),
}));

vi.mock('../api/grove.js', async (orig) => ({
  ...(await orig<typeof groveApi>()),
  listLeaves: vi.fn().mockResolvedValue([]),
}));

vi.mock('../api/packs.js', async (orig) => ({
  ...(await orig<typeof packsApi>()),
  listPacks: vi.fn(),
}));

// PersonaConfigDrawer pulls in tools/models/harness-profile queries well beyond what this test
// cares about — stub it to a marker so we can assert *that* it opened, not its internals.
vi.mock('./PersonaConfigDrawer.js', () => ({
  default: ({ activePackId }: { activePackId: string }) => <div data-testid="config-drawer">{activePackId}</div>,
}));

const setup = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Personas />
    </QueryClientProvider>,
  );
};

describe('Personas', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockPersonas = [
    { id: 'p-koala', name: 'Koala', description: 'General chat.' },
    { id: 'p-bare', name: 'Bare Persona', description: 'No pack yet.' },
  ];

  const mockPacks = [
    { id: 'pack-koala', name: 'Koala', personaId: 'p-koala' },
  ];

  it('opens PersonaConfigDrawer, not PersonaEditor, when editing a pack-bound persona', async () => {
    vi.mocked(personasApi.listPersonas).mockResolvedValue(mockPersonas as any);
    vi.mocked(packsApi.listPacks).mockResolvedValue(mockPacks as any);

    setup();
    await screen.findByText('General chat.');

    fireEvent.click(screen.getByTitle('Configure pack — tools, sampling, prompt'));

    expect(await screen.findByTestId('config-drawer')).toHaveTextContent('pack-koala');
    expect(screen.queryByText('Edit Koala')).not.toBeInTheDocument();
  });

  it('opens PersonaEditor when editing a persona with no pack', async () => {
    vi.mocked(personasApi.listPersonas).mockResolvedValue(mockPersonas as any);
    vi.mocked(packsApi.listPacks).mockResolvedValue(mockPacks as any);

    setup();
    await screen.findByText('Bare Persona');

    fireEvent.click(screen.getByTitle('Edit'));

    expect(await screen.findByText('Edit Bare Persona')).toBeInTheDocument();
    expect(screen.queryByTestId('config-drawer')).not.toBeInTheDocument();
  });

  it('shows "no pack" for a persona with none, and opens the creator for a new one', async () => {
    vi.mocked(personasApi.listPersonas).mockResolvedValue(mockPersonas as any);
    vi.mocked(packsApi.listPacks).mockResolvedValue(mockPacks as any);

    setup();
    await screen.findByText('Bare Persona');
    expect(screen.getByText('no pack')).toBeInTheDocument();

    fireEvent.click(screen.getByText('New persona'));
    expect(await screen.findByText('New persona', { selector: 'h3' })).toBeInTheDocument();
  });

  it('deletes a persona on click', async () => {
    vi.mocked(personasApi.listPersonas).mockResolvedValue(mockPersonas as any);
    vi.mocked(packsApi.listPacks).mockResolvedValue(mockPacks as any);
    vi.mocked(personasApi.deletePersona).mockResolvedValue(undefined as any);

    setup();
    await screen.findByText('General chat.');

    fireEvent.click(screen.getAllByTitle('Delete')[0]!);

    await waitFor(() => expect(personasApi.deletePersona).toHaveBeenCalledWith('p-koala'));
  });
});
