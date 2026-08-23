import { useShellStore, type ViewName } from '../stores/shell';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Box, Server } from 'lucide-react';
import Sidebar from '../components/Sidebar';

/**
 * The navigation, rendered.
 *
 * ── WHY THIS EXISTS ──
 * Sidebar was extracted from a 3,284-line App with no render coverage at all, and the extraction
 * beside it broke on `ReferenceError: Puzzle is not defined` — an icon my regex missed, caught only
 * because an unrelated test happened to render that screen. Moving markup out of App is safe exactly
 * to the extent something renders it afterwards.
 *
 * These assert wiring, not layout: jsdom cannot see a stray scrollbar, and every bug found in this
 * UI so far has been a wiring bug.
 */

const TABS = [
  { id: 'clusters', label: 'Clusters', icon: Server },
  { id: 'apps', label: 'Applications', icon: Box },
];

/**
 * Sidebar reads the shell store directly now rather than taking `view`/`setView` as props, so the
 * setup drives the real store instead of passing spies. That is a better test: it asserts the
 * sidebar actually CHANGES the shell, not merely that it called a function it was handed.
 */
const setup = (init: { view?: ViewName; forestOpen?: boolean } = {}) => {
  useShellStore.setState({ view: init.view ?? 'chat', forestOpen: init.forestOpen ?? false });
  const onLogout = vi.fn();
  render(<Sidebar forestTabs={TABS} onLogout={onLogout} />);
  return {
    onLogout,
    view: () => useShellStore.getState().view,
    forestOpen: () => useShellStore.getState().forestOpen,
  };
};

describe('what the nav offers', () => {
  it('renders the harness entries', () => {
    setup();
    for (const label of ['Koala', 'Projects', 'Personas', 'Lab', 'Forest']) {
      expect(screen.getByText(label), label).toBeInTheDocument();
    }
  });

  it('keeps the Forest tabs hidden until it is opened', () => {
    // Lab used to live two levels down inside Forest, whose open state was not persisted — so
    // collapsing Forest made it vanish. It is a sibling now, and must not be inside this.
    setup();
    expect(screen.queryByText('Clusters')).not.toBeInTheDocument();
    expect(screen.getByText('Lab')).toBeInTheDocument();
  });

  it('shows them when it is open', () => {
    setup({ forestOpen: true });
    expect(screen.getByText('Clusters')).toBeInTheDocument();
    expect(screen.getByText('Applications')).toBeInTheDocument();
  });
});

describe('what clicking does', () => {
  it('navigates to each harness view', () => {
    // Asserts the shell actually moved, rather than that a prop was called with a string.
    const { view } = setup();
    for (const [label, id] of [['Koala', 'chat'], ['Projects', 'grove'], ['Personas', 'personas'], ['Lab', 'lab']]) {
      fireEvent.click(screen.getByText(label!));
      expect(view(), label).toBe(id);
    }
  });

  it('navigates to a Forest tab by its id', () => {
    const { view } = setup({ forestOpen: true });
    fireEvent.click(screen.getByText('Applications'));
    expect(view()).toBe('apps');
  });

  it('toggles Forest rather than setting it', () => {
    // Both directions from one handler, which is why the action accepts an updater.
    const { forestOpen } = setup({ forestOpen: false });
    fireEvent.click(screen.getByText('Forest'));
    expect(forestOpen()).toBe(true);
    fireEvent.click(screen.getByText('Forest'));
    expect(forestOpen()).toBe(false);
  });

  it('logs out', () => {
    const { onLogout } = setup();
    fireEvent.click(screen.getByText('Log Out'));
    expect(onLogout).toHaveBeenCalled();
  });
});

describe('what the current view looks like', () => {
  it('marks the active entry, so you can tell where you are', () => {
    setup({ view: 'lab' });
    expect(screen.getByText('Lab').className).toMatch(/bg-\[var\(--bark-600\)\]/);
    expect(screen.getByText('Personas').className).not.toMatch(/bg-\[var\(--bark-600\)\]/);
  });

  it('marks the active Forest tab too', () => {
    setup({ view: 'apps', forestOpen: true });
    expect(screen.getByText('Applications').className).toMatch(/bg-\[var\(--bark-600\)\]/);
  });
});
