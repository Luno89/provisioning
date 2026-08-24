import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import NginxView from '../components/NginxView';

/**
 * The Nginx router screen, rendered.
 *
 * ── WHY THIS EXISTS ──
 * It was extracted from App with no render coverage of its own. The extraction broke on
 * `ReferenceError: Puzzle is not defined` — an icon my regex missed — and was caught only because
 * the NginxWizard test happens to render this screen on its way to the wizard. That was luck, not
 * coverage: nothing asserted the screen itself.
 *
 * Every prop here was wrong on the first attempt. `clusters` was missing entirely, the mutation was
 * hand-typed as `{isPending, mutate}` before the compiler produced three more fields, and
 * `setEditorContent` turned out to be a React setter because the wizard appends with a function
 * updater. A rendering test is what turns that from a guess into a fact.
 */

const mutation = (over: Record<string, unknown> = {}) => ({
  isPending: false, isSuccess: false, isError: false, error: null,
  mutate: vi.fn(), ...over,
}) as any;

const setup = (over: Record<string, unknown> = {}) => {
  const props = {
    editorContent: 'server { listen 80; }',
    setEditorContent: vi.fn(),
    loadingNginxConfig: false,
    updateNginxConfig: mutation(),
    deployments: [{ id: 'd1', name: 'weather', status: 'running' }],
    clusters: [{ id: 'c1', name: 'local' }],
    vpnDomains: {} as Record<string, string>,
    setVpnDomains: vi.fn(),
    onAddRoute: vi.fn(),
    ...over,
  };
  render(<NginxView {...(props as any)} />);
  return props;
};

describe('the screen renders at all', () => {
  it('shows its heading and the current config', () => {
    // The whole point: an icon that does not resolve throws on render, and nothing else here would
    // have noticed.
    setup();
    expect(screen.getByText('Nginx Router Settings')).toBeInTheDocument();
    expect(screen.getByDisplayValue('server { listen 80; }')).toBeInTheDocument();
  });

  it('renders with no deployments and no clusters', () => {
    // A fresh account. An empty list must not be a crash.
    expect(() => setup({ deployments: [], clusters: [] })).not.toThrow();
    expect(screen.getByText('Nginx Router Settings')).toBeInTheDocument();
  });
});

describe('saving', () => {
  it('sends the editor content', () => {
    const props = setup();
    fireEvent.click(screen.getByText(/Save/i));
    expect(props.updateNginxConfig.mutate).toHaveBeenCalledWith('server { listen 80; }');
  });

  it('disables the button while a save is in flight', () => {
    // Two writes racing over one config file is how a hand-edited block gets lost.
    setup({ updateNginxConfig: mutation({ isPending: true }) });
    expect(screen.getByText(/Save/i).closest('button')).toBeDisabled();
  });

  it('disables it while the config is still loading', () => {
    // Saving before the editor has the current content would write an empty file over a live one.
    setup({ loadingNginxConfig: true });
    expect(screen.getByText(/Save/i).closest('button')).toBeDisabled();
  });
});

describe('the proxy wizard', () => {
  it('asks to open the wizard, and nothing more', () => {
    /**
     * This used to assert three separate setters — `setShowNginxWizard(true)`,
     * `setNginxWizardStep(1)` and `setNginxWizardData({…})` — because opening the wizard without
     * resetting it left the previous domain in the field and reopened on whatever step it had been
     * abandoned at.
     *
     * That concern is structural now rather than this screen's job: the wizard unmounts when it
     * closes, so it starts clean. `NginxWizard.test.tsx` asserts that property where it lives.
     */
    const props = setup();
    fireEvent.click(screen.getByText(/Proxy Wizard/i));
    expect(props.onAddRoute).toHaveBeenCalled();
  });
});
