import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as personasApi from '../api/personas';
import PersonaEditor from '../components/PersonaEditor';

vi.mock('../api/personas', async (importOriginal) => ({
  ...(await importOriginal<typeof personasApi>()),
  getPersonaOptions: vi.fn(),
  updatePersona: vi.fn(),
  createPersona: vi.fn(),
}));

const options = {
  languages: [{ id: 'node', image: 'ubi9/nodejs-22', summary: 'Node.js 22 + npm.', available: [], absent: [] }],
  tools: [{ name: 'run_command' }, { name: 'write_file' }, { name: 'finish' }],
  defaults: { cpu: '2', memory: '2Gi', maxSteps: 40 },
};

const builder = {
  id: 'p1', name: 'Builder', systemPrompt: 'You write code.',
  scope: { repo: true, language: 'node', tools: ['run_command'], egress: [{ namespace: 'gitea', ports: [3000] }] },
};

const draw = (persona?: any) => {
  vi.mocked(personasApi.getPersonaOptions).mockResolvedValue(options as never);
  vi.mocked(personasApi.updatePersona).mockResolvedValue({} as never);
  vi.mocked(personasApi.createPersona).mockResolvedValue({} as never);
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PersonaEditor {...(persona ? { persona } : {})} personas={[builder]} onClose={() => {}} />
    </QueryClientProvider>,
  );
};

beforeEach(() => vi.clearAllMocks());

describe('editing a persona', () => {
  it('shows what it can currently reach', async () => {
    draw(builder);
    await waitFor(() => expect(screen.getByDisplayValue('gitea')).toBeInTheDocument());
    expect(screen.getByDisplayValue('3000')).toBeInTheDocument();
  });

  it('warns when a persona can reach nothing', async () => {
    draw({ ...builder, scope: { ...builder.scope, egress: [] } });
    expect(await screen.findByText(/can reach DNS and nothing else/i)).toBeInTheDocument();
  });

  it('sends the whole scope, not just the fields it was born with', async () => {
    draw(builder);
    await waitFor(() => expect(screen.getByDisplayValue('gitea')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => {
      const body = vi.mocked(personasApi.updatePersona).mock.calls[0]![1] as any;
      expect(body.scope.egress).toEqual([{ namespace: 'gitea', ports: [3000] }]);
      expect(body.scope.repo).toBe(true);
      expect(body.scope.tools).toEqual(['run_command']);
    });
  });

  it('adds and removes an egress rule', async () => {
    draw(builder);
    await waitFor(() => expect(screen.getByDisplayValue('gitea')).toBeInTheDocument());
    fireEvent.click(screen.getByText(/allow something/));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => {
      expect((vi.mocked(personasApi.updatePersona).mock.calls[0]![1] as any).scope.egress).toHaveLength(2);
    });
  });

  it('refuses overrides that are not JSON before sending them', async () => {
    draw(builder);
    await waitFor(() => expect(screen.getByDisplayValue('gitea')).toBeInTheDocument());
    const overrides = screen.getByText('Sampling overrides').parentElement!.querySelector('textarea')!;
    fireEvent.change(overrides, { target: { value: '{not json' } });
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByText(/not valid JSON/i)).toBeInTheDocument();
    expect(vi.mocked(personasApi.updatePersona)).not.toHaveBeenCalled();
  });

  it('creates a new persona rather than editing one', async () => {
    draw();
    const name = screen.getByText('Name').parentElement!.querySelector('input')!;
    fireEvent.change(name, { target: { value: 'Auditor' } });
    fireEvent.click(screen.getByText('Create'));
    await waitFor(() => expect(vi.mocked(personasApi.createPersona)).toHaveBeenCalled());
  });
});
