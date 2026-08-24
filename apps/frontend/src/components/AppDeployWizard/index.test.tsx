import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AppDeployWizard from './index';
import * as modelsApi from '../../api/models';
import type { Cluster } from '../../types/cluster';

/**
 * ── REPLACES __tests__/Wizard.test.tsx ──
 *
 * That file mounted the whole `App` and mocked `axios` wholesale to assert two things: that the
 * steps advance, and that the database step is skipped for an app without one. Both are pure
 * branching, and both are covered directly in `steps.test.ts` now — over every app type, in
 * milliseconds, with a round-trip check that Back retraces the same skips as Next.
 *
 * What a render test is still needed for is the WIRING: that the wizard reaches its parent through
 * the two callbacks rather than through App's state, which is the whole point of the extraction.
 */

vi.mock('../../api/models', async (importOriginal) => ({
  ...(await importOriginal<typeof modelsApi>()),
  useImageTags: vi.fn(() => ({ data: [], isLoading: false })),
  useHfModelSize: vi.fn(() => ({ data: undefined, isFetching: false, isError: false })),
  useModelSearch: vi.fn(() => ({ data: [], isFetching: false })),
  useTabbyImageTags: vi.fn(() => ({ options: [], loading: false })),
  useHfBranches: vi.fn(() => ({ data: [], isFetching: false })),
}));

const clusters: Cluster[] = [
  { id: 'c1', name: 'dev', provider: 'k3d', status: 'healthy' },
];

const setup = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const onDeploy = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <AppDeployWizard clusters={clusters} deployments={[]} onClose={onClose} onDeploy={onDeploy} />
    </QueryClientProvider>,
  );
  return { onClose, onDeploy, user: userEvent.setup() };
};

beforeEach(() => { vi.clearAllMocks(); });

describe('the deploy wizard', () => {
  it('opens on the cluster step, offering the clusters it was given', () => {
    setup();
    // Rendered as <option>s, so `getByRole('option')` rather than text — which is also what makes
    // this assert the picker is populated rather than that the word appears somewhere.
    expect(screen.getByRole('option', { name: /dev/ })).toBeDefined();
  });

  it('closes through its callback, not by reaching into App', () => {
    // It used to call `setShowAppModal(false)` — App's own setter, handed down as a prop.
    const { onClose } = setup();
    screen.getByLabelText('Close Wizard').click();
    expect(onClose).toHaveBeenCalled();
  });

  it('starts from a clean slate every time it mounts', () => {
    /**
     * The reason `AppsView` no longer resets it. The wizard unmounts on close, so its state goes
     * with it — which is what let a 44-key `setWizardData({…})` literal be deleted from an onClick
     * in a different file, where it was a second hand-maintained copy of the defaults.
     */
    setup();
    expect(screen.getByDisplayValue('Odoo-Production')).toBeDefined();
  });
});
