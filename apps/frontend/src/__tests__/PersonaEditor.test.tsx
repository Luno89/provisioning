import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as personasApi from '../api/personas';
import PersonaEditor from '../components/PersonaEditor';

vi.mock('../api/personas', async (importOriginal) => ({
  ...(await importOriginal<typeof personasApi>()),
  updatePersona: vi.fn(),
  createPersona: vi.fn(),
}));

const builder = { id: 'p1', name: 'Builder', systemPrompt: 'You write code.' };

const draw = (persona?: any) => {
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
  it('sends name, description, system prompt and basedOn on save', async () => {
    draw(builder);
    const prompt = screen.getByText('System prompt').parentElement!.querySelector('textarea')!;
    fireEvent.change(prompt, { target: { value: 'You write tests too.' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => {
      const body = vi.mocked(personasApi.updatePersona).mock.calls[0]![1] as any;
      expect(body).toEqual({
        name: 'Builder', description: '', systemPrompt: 'You write tests too.', basedOn: '',
      });
    });
  });

  it('creates a new persona rather than editing one', async () => {
    draw();
    const name = screen.getByText('Name').parentElement!.querySelector('input')!;
    fireEvent.change(name, { target: { value: 'Auditor' } });
    fireEvent.click(screen.getByText('Create'));
    await waitFor(() => expect(vi.mocked(personasApi.createPersona)).toHaveBeenCalled());
  });
});
