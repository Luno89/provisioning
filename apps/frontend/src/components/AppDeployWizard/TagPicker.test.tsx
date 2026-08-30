import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TagPicker } from './TagPicker';
import * as modelsApi from '../../api/models';

vi.mock('../../api/models', async (importOriginal) => ({
  ...(await importOriginal<typeof modelsApi>()),
  useImageTags: vi.fn(),
}));

const useImageTags = vi.mocked(modelsApi.useImageTags);

const page = (over: Partial<modelsApi.TagPage> = {}): modelsApi.TagPage => ({
  tags: ['latest', 'v2.0.0'], page: 1, pageSize: 30, total: 2, totalPages: 1, sort: 'newest', ...over,
});

const mockPage = (over: Partial<modelsApi.TagPage> = {}, flags: Record<string, boolean> = {}) => {
  useImageTags.mockReturnValue({
    data: page(over), isLoading: false, isFetching: false, ...flags,
  } as unknown as ReturnType<typeof modelsApi.useImageTags>);
};

const setup = (selected = '') => {
  const onSelect = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TagPicker repo="library/odoo" selected={selected} onSelect={onSelect} enabled />
    </QueryClientProvider>,
  );
  return { onSelect };
};

describe('TagPicker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders a button per tag and reports the total', () => {
    mockPage({ tags: ['latest', 'v2.0.0', 'v1.0.0'], total: 97, totalPages: 4 });
    setup();
    expect(screen.getByRole('button', { name: 'latest' })).toBeInTheDocument();
    expect(screen.getByText('97 found')).toBeInTheDocument();
  });

  it('reports the selected tag back on click', async () => {
    mockPage();
    const { onSelect } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'v2.0.0' }));
    expect(onSelect).toHaveBeenCalledWith('v2.0.0');
  });

  it('hides the pager when everything fits on one page', () => {
    mockPage({ totalPages: 1 });
    setup();
    expect(screen.queryByRole('button', { name: /Next/ })).not.toBeInTheDocument();
  });

  it('advances the page and asks the API for it', async () => {
    mockPage({ totalPages: 3 });
    setup();
    expect(useImageTags).toHaveBeenLastCalledWith('library/odoo', true, { page: 1, sort: 'newest' });

    await userEvent.click(screen.getByRole('button', { name: /Next/ }));
    expect(useImageTags).toHaveBeenLastCalledWith('library/odoo', true, { page: 2, sort: 'newest' });
  });

  it('disables Prev on the first page', () => {
    mockPage({ totalPages: 3 });
    setup();
    expect(screen.getByRole('button', { name: /Prev/ })).toBeDisabled();
  });

  it('changing the sort resets to page one', async () => {
    mockPage({ totalPages: 3 });
    setup();
    await userEvent.click(screen.getByRole('button', { name: /Next/ }));
    expect(useImageTags).toHaveBeenLastCalledWith('library/odoo', true, { page: 2, sort: 'newest' });

    await userEvent.selectOptions(screen.getByLabelText('Sort tags'), 'version');
    expect(useImageTags).toHaveBeenLastCalledWith('library/odoo', true, { page: 1, sort: 'version' });
  });

  it('says so when a repo returns no tags at all', () => {
    mockPage({ tags: [], total: 0 });
    setup();
    expect(screen.getByText(/No tags found/)).toBeInTheDocument();
  });

  it('keeps a selection visible when it is not on the current page', () => {
    mockPage({ tags: ['latest'], totalPages: 4 });
    setup('v9.9.9');
    expect(within(screen.getByText(/not on this page/).parentElement!).getByText('v9.9.9')).toBeInTheDocument();
  });
});
