import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CustomSteps } from './CustomSteps.js';
import * as customStepsApi from '../../api/custom-steps.js';
import type { CustomStepDefinition } from '../../types/grove.js';

vi.mock('../../api/custom-steps.js', async (orig) => ({
  ...(await orig<typeof customStepsApi>()),
  listCustomSteps: vi.fn(),
  createCustomStep: vi.fn(),
  updateCustomStep: vi.fn(),
  deleteCustomStep: vi.fn(),
}));

const def = (over: Partial<CustomStepDefinition> = {}): CustomStepDefinition => ({
  id: 'lighthouse', name: 'Lighthouse score', fields: [{ key: 'url', label: 'URL', kind: 'string' }],
  command: 'lighthouse {{url}}', ...over,
});

function renderPanel(definitions: CustomStepDefinition[] = []) {
  vi.mocked(customStepsApi.listCustomSteps).mockResolvedValue(definitions);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CustomSteps />
    </QueryClientProvider>,
  );
}

describe('CustomSteps panel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is collapsed by default and expands to list definitions', async () => {
    renderPanel([def()]);
    expect(screen.queryByText('Lighthouse score')).toBeNull();

    fireEvent.click(screen.getByText('Custom step types'));
    expect(await screen.findByText('Lighthouse score')).toBeInTheDocument();
  });

  it('creates a new definition with a field', async () => {
    vi.mocked(customStepsApi.createCustomStep).mockResolvedValue(def());
    renderPanel([]);
    fireEvent.click(screen.getByText('Custom step types'));

    fireEvent.click(await screen.findByRole('button', { name: /new custom step type/i }));
    fireEvent.change(screen.getByPlaceholderText('lighthouse-check'), { target: { value: 'lighthouse' } });
    fireEvent.change(screen.getByPlaceholderText('Lighthouse score check'), { target: { value: 'Lighthouse score' } });
    fireEvent.change(screen.getByPlaceholderText(/lighthouse \{\{url\}\}/), { target: { value: 'lighthouse {{url}}' } });

    fireEvent.click(screen.getByRole('button', { name: /^add field$/i }));
    const keyInput = screen.getByPlaceholderText('key');
    fireEvent.change(keyInput, { target: { value: 'url' } });

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(customStepsApi.createCustomStep).toHaveBeenCalled());
    const body = vi.mocked(customStepsApi.createCustomStep).mock.calls[0]![0];
    expect(body.id).toBe('lighthouse');
    expect(body.fields).toEqual([{ key: 'url', label: '', kind: 'string' }]);
  });

  it('deletes a definition', async () => {
    vi.mocked(customStepsApi.deleteCustomStep).mockResolvedValue({ deleted: 'lighthouse' });
    renderPanel([def()]);
    fireEvent.click(screen.getByText('Custom step types'));
    await screen.findByText('Lighthouse score');

    fireEvent.click(screen.getByTitle('Delete'));
    await waitFor(() => expect(customStepsApi.deleteCustomStep).toHaveBeenCalledWith('lighthouse'));
  });
});
