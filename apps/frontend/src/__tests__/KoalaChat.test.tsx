import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import axios from 'axios';
import KoalaChat from '../components/KoalaChat';

/**
 * Koala's transcript, and the three things it was not showing.
 *
 * ── WHAT WAS WRONG ──
 * · Replies rendered with `whitespace-pre-wrap`, so the better Koala formatted an answer the worse
 *   it read — a markdown table arrived as rows of pipe characters. Branch chat had rendered these
 *   properly for a while; this surface never caught up.
 * · Tool calls were invisible. Koala shells out to kubectl for pod logs and crosses the network for
 *   MCP calls, and all of it rendered as "Koala is thinking…" — so a slow tool and a stuck app
 *   looked identical, and afterwards nothing said whether an answer came from a tool or from the
 *   model's imagination.
 * · Nothing could say something the model had not said. The context handoff needed a way to tell a
 *   reader that older messages were summarised, and attributing that to Koala would be a lie about
 *   who said it.
 */

vi.mock('axios');
const mocked = vi.mocked(axios, true);

const thread = (messages: unknown[]) => ({
  id: 'c1', title: 'Chat', messages, proposedTrees: [], proposedSpecs: [],
});

/**
 * `selected` starts null — a thread is only opened by clicking it — so every test picks one first.
 * Doing that here keeps each test about what is rendered rather than about how to get there.
 */
const mount = async (messages: unknown[]) => {
  mocked.get.mockImplementation((url: string) => {
    if (url.endsWith('/koala/conversations')) {
      return Promise.resolve({ data: [{ id: 'c1', title: 'Chat', updatedAt: 'now' }] } as any);
    }
    return Promise.resolve({ data: thread(messages) } as any);
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <KoalaChat apiBase="http://localhost:3001/api" onOpenTree={vi.fn()} />
    </QueryClientProvider>,
  );
  // The row is a clickable div, not a button — click its title text.
  fireEvent.click(await screen.findByText('Chat'));
  return view;
};

describe('how a reply is rendered', () => {
  it('renders Koala’s markdown as markdown', async () => {
    await mount([{ role: 'assistant', content: '## Findings\n\n- one\n- two', at: 'now' }]);

    // A heading, not the literal characters "## Findings".
    expect(await screen.findByRole('heading', { name: 'Findings' })).toBeInTheDocument();
    expect(screen.getByText('one')).toBeInTheDocument();
  });

  it('leaves what the USER typed alone', async () => {
    // Their asterisks are theirs. Rendering the user's own message as markdown eats them.
    await mount([{ role: 'user', content: 'call it **thing** please', at: 'now' }]);

    expect(await screen.findByText(/call it \*\*thing\*\* please/)).toBeInTheDocument();
  });
});

describe('showing what the turn actually did', () => {
  it('names each tool that ran', async () => {
    await mount([{
      role: 'assistant', content: 'Here you go.', at: 'now',
      toolCalls: [{ id: '1', name: 'get_logs', args: '{"deployment":"mongo"}', ok: true, digest: 'CrashLoop' }],
    }]);

    expect(await screen.findByText('get_logs')).toBeInTheDocument();
  });

  it('distinguishes a call that failed from one that worked', async () => {
    // `ok` is derived from the tool RESULT, never from the model's account of it — so the record
    // can disagree with the prose, which is the entire reason it exists.
    const { container } = await mount([{
      role: 'assistant', content: 'Could not read those.', at: 'now',
      toolCalls: [
        { id: '1', name: 'list_trees', args: '{}', ok: true, digest: '{}' },
        { id: '2', name: 'get_logs', args: '{}', ok: false, digest: '{"error":"no access"}' },
      ],
    }]);

    expect(await screen.findByText('list_trees')).toBeInTheDocument();
    expect(screen.getByText('get_logs')).toBeInTheDocument();
    // One tick, one cross — rendered as icons, so assert on the count of distinct states.
    expect(container.querySelectorAll('.text-emerald-400').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.text-rose-400').length).toBeGreaterThan(0);
  });
});

describe('a message the harness wrote', () => {
  it('renders a handoff as a notice, not as something Koala said', async () => {
    await mount([{
      role: 'assistant', notice: true, handoff: true, at: 'now',
      content: 'Earlier messages in this conversation were summarised to fit the context window.\n\n**What this conversation is about**\nShip the invoicer',
    }]);

    const headline = await screen.findByText(/Earlier messages in this conversation were summarised/);
    expect(headline).toBeInTheDocument();
    // Collapsed by default: reassuring at a glance, auditable on demand.
    expect(screen.queryByText(/Ship the invoicer/)).not.toBeInTheDocument();
    expect(screen.getByText('what was kept')).toBeInTheDocument();
  });

  it('renders a plain notice without an expander, since it summarises nothing', async () => {
    await mount([{
      role: 'assistant', notice: true, at: 'now',
      content: 'Koala used all 12 tool rounds without reaching an answer.',
    }]);

    expect(await screen.findByText(/used all 12 tool rounds/)).toBeInTheDocument();
    expect(screen.queryByText('what was kept')).not.toBeInTheDocument();
  });
});
