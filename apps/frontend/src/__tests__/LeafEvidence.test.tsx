import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import * as modelsApi from '../api/models';
import ChatSurface from '../components/ChatSurface';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import LeafDetail from '../components/LeafDetail';
import AcceptancePlan from '../components/AcceptancePlan';
import type { Leaf } from '../components/leaf-types';

vi.mock('axios');

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
    show(leaf({ verified: true }));
    expect(screen.getByText('Verified')).toBeTruthy();
    expect(screen.getByText(/a check ran and passed/i)).toBeTruthy();
  });

  it('calls an unchecked success a claim, without calling it a failure', () => {
    show(leaf({ verified: false }));
    expect(screen.getByText('Claimed')).toBeTruthy();
    expect(screen.getByText(/nothing checked this/i)).toBeTruthy();
    expect(screen.queryByText(/Failed/)).toBeNull();
  });

  it('says nothing about verification for work that has not finished', () => {
    show(leaf({ status: 'running' }));
    expect(screen.queryByText(/nothing checked this/i)).toBeNull();
  });
});

describe('where the work went', () => {
  it('names the branch when the work has not merged', () => {
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
    show(leaf({ status: 'pending', dependsOn: ['a', 'b'] }));
    expect(screen.getByText(/waits on 2 other leaves/i)).toBeTruthy();
  });

  it('names what it waits on when those leaves are to hand', () => {
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
    render(<AcceptancePlan acceptance={[{ name: 'tests pass', command: 'npm test' }]} />);

    expect(screen.getByText(/tests pass/)).toBeTruthy();
    expect(screen.getByText('npm test')).toBeTruthy();
  });

  it('reads the older single-command form', () => {
    render(<AcceptancePlan acceptance={'node cli.js Seattle'} />);
    expect(screen.getByText('node cli.js Seattle')).toBeTruthy();
  });

  it('renders nothing when no checks are declared', () => {
    const { container } = render(<AcceptancePlan acceptance={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('system notices in the transcript', () => {
  it('renders a notice as an event, not as the assistant speaking', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ChatSurface
          scope={{
            kind: 'branch',
            branchId: 'b1',
            mode: 'auto',
            messages: [{ role: 'assistant', content: 'Leaf failed and will not be retried.', notice: true }],
            onMessagesChange: () => {},
          }}
        />
      </QueryClientProvider>,
    );

    expect(await screen.findByText(/Leaf failed and will not be retried/)).toBeTruthy();
  });
});
