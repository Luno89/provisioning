import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import * as modelsApi from '../api/models';
import Chat from '../components/Chat';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import LeafDetail from '../components/LeafDetail';
import AcceptancePlan from '../components/AcceptancePlan';
import type { Leaf } from '../components/leaf-types';

/**
 * The backend recorded all of this for a session and none of it reached the screen. Every green
 * result was confirmed by reading Mongo, port-forwarding Gitea, and cloning the repo by hand —
 * which is not a thing a user can do, so the product had no way to show that anything had been
 * checked.
 */
// LeafDetail and AcceptancePlan still go through axios directly; Chat goes through api/models.
// Both are mocked until those two components are converted as well.
vi.mock('axios');

/**
 * Chat blocks on its model list before rendering a transcript at all, so a notice is only
 * reachable once that query has resolved. Mocked at the api module, because `vi.mock('axios')`
 * cannot reach the instance `api/client` builds with `axios.create()`.
 */
vi.mock('../api/models', async (importOriginal) => ({
  ...(await importOriginal<typeof modelsApi>()),
  listModels: vi.fn().mockResolvedValue([
    { id: 'm1', name: 'Model', source: 'deployment', kind: 'tabbyapi', model: 'm' },
  ]),
}));

const leaf = (over: Partial<Leaf> = {}): Leaf => ({
  id: 'l1', branchId: 'b1', title: 'Build the parser',
  status: 'succeeded', depth: 0, blocking: true, childCount: 0, ...over,
} as Leaf);

const show = (l: Leaf) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <LeafDetail leaf={l} subLeaves={[]} />
  </QueryClientProvider>,
);

describe('what checked a leaf', () => {
  it('distinguishes a verified success from a claimed one', () => {
    /**
     * The board rendered both as the same green dot. "Its tests ran and passed" and "an agent said
     * so" are very different claims and the interface made them identical.
     */
    show(leaf({ verified: true }));
    // The state word, and the reason under it — one says WHICH, the other says WHY.
    expect(screen.getByText('Verified')).toBeTruthy();
    expect(screen.getByText(/a check ran and passed/i)).toBeTruthy();
  });

  it('calls an unchecked success a claim, without calling it a failure', () => {
    // An unverified success is still a success — most work is not test-shaped. It is just not
    // evidence.
    show(leaf({ verified: false }));
    expect(screen.getByText('Claimed')).toBeTruthy();
    expect(screen.getByText(/nothing checked this/i)).toBeTruthy();
    // The half that matters: it must not be dressed as a failure. Most work is not test-shaped.
    expect(screen.queryByText(/Failed/)).toBeNull();
  });

  it('says nothing about verification for work that has not finished', () => {
    show(leaf({ status: 'running' }));
    expect(screen.queryByText(/nothing checked this/i)).toBeNull();
  });
});

describe('where the work went', () => {
  it('names the branch when the work has not merged', () => {
    // There was no path at all from a finished leaf to the code it produced.
    show(leaf({ verified: true, outputBranch: 'koala/deadbeef' }));
    expect(screen.getByText('koala/deadbeef')).toBeTruthy();
  });

  it('says it is on main once merged', () => {
    show(leaf({ verified: true, merged: true, outputBranch: 'koala/deadbeef' }));
    expect(screen.getByText(/on main/i)).toBeTruthy();
  });
});

describe('what a leaf promised and waits on', () => {
  it('shows the files it must produce', () => {
    show(leaf({ expects: ['src/parse.js'] }));
    expect(screen.getByText(/must produce src\/parse\.js/i)).toBeTruthy();
  });

  it('shows that it waits on other work', () => {
    // The ordering you agreed to when you accepted, which appeared nowhere.
    show(leaf({ status: 'pending', dependsOn: ['a', 'b'] }));
    expect(screen.getByText(/waits on 2 other leaves/i)).toBeTruthy();
  });

  it('names what it waits on when those leaves are to hand', () => {
    // "waits on the transport leaf" is actionable where a count is not.
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <LeafDetail
          leaf={leaf({ status: 'pending', dependsOn: ['a'] })}
          subLeaves={[]}
          all={[leaf({ id: 'a', title: 'Add the transport', status: 'running' })]}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/waits on Add the transport/i)).toBeTruthy();
  });

  it('does not claim finished work is still waiting', () => {
    /**
     * A succeeded leaf keeps its dependsOn — it is history, not a queue. Rendering the raw length
     * had a leaf that was merged and verified reporting that it waited on two other leaves.
     */
    show(leaf({ status: 'succeeded', verified: true, dependsOn: ['a', 'b'] }));
    expect(screen.queryByText(/waits on/i)).toBeNull();
  });

  it('labels the summary as a report rather than a result', () => {
    show(leaf({ summary: 'Created the parser and its tests.' }));
    expect(screen.getByText(/what it reported/i)).toBeTruthy();
  });
});

describe('the acceptance plan', () => {
  it('shows every check, command included', () => {
    /**
     * The planner writes these itself, which is only safe because a person reads them before
     * agreeing to the work. That argument was made twice while the field appeared nowhere in the
     * interface — so the command is shown, not just the friendly name the model chose.
     */
    render(<AcceptancePlan acceptance={[{ name: 'tests pass', command: 'npm test' }]} />);

    expect(screen.getByText(/tests pass/)).toBeTruthy();
    expect(screen.getByText('npm test')).toBeTruthy();
  });

  it('reads the older single-command form', () => {
    render(<AcceptancePlan acceptance={'node cli.js Seattle'} />);
    expect(screen.getByText('node cli.js Seattle')).toBeTruthy();
  });

  it('renders nothing when no checks are declared', () => {
    // An empty panel would read as "no checks required". The plan review says so in the
    // conversation, which is where a warning belongs.
    const { container } = render(<AcceptancePlan acceptance={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('system notices in the transcript', () => {
  it('renders a notice as an event, not as the assistant speaking', async () => {
    /**
     * These carry the assistant role because `BranchMessage` has no system role, so before this
     * they rendered with Koala's avatar — an automated failure report was indistinguishable from
     * the model claiming to have noticed it.
     */
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Chat
          messages={[{ role: 'assistant', content: 'Leaf failed and will not be retried.', notice: true }]}
          onMessagesChange={() => {}}
        />
      </QueryClientProvider>,
    );

    expect(await screen.findByText(/Leaf failed and will not be retried/)).toBeTruthy();
  });
});
