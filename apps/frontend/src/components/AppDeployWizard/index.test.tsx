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

/**
 * The path E2E takes, walked here in milliseconds.
 *
 * ── WHY THIS TEST EXISTS ──
 * The E2E suite's `deployApplication` helper drives every app-deploy test, and all of them failed
 * at the same point: the wizard sat on step 6 with a fully-populated summary and a click on
 * "Initiate Deployment" produced nothing. That is a 15-minute round trip per attempt, needs a real
 * k3d cluster, and reports only that a heading never appeared.
 *
 * The wizard's own contract is one callback, so it is assertable in a render test — and it was not
 * asserted. Three tests covered opening, closing and step branching; nothing covered the button
 * the whole feature exists for.
 */
describe('reaching the parent on deploy', () => {
  /** Clicks through to the confirm step exactly the way the E2E helper does. */
  async function walkToConfirm(user: ReturnType<typeof userEvent.setup>, appType: string) {
    // Cluster AND app type are both step 1 — picking the type here is what decides which later
    // steps exist at all, which is why `nextStep` takes the app type.
    await user.selectOptions(screen.getByLabelText(/target cluster/i), 'c1');
    await user.selectOptions(screen.getByLabelText(/application type/i), appType);
    for (let i = 0; i < 5; i++) {
      const next = screen.queryByRole('button', { name: /^Next/ });
      if (!next) break;
      await user.click(next);
    }
  }

  it('calls onDeploy with the assembled payload when Initiate Deployment is clicked', async () => {
    const { onDeploy, user } = setup();
    await walkToConfirm(user, 'wordpress');

    const initiate = screen.getByRole('button', { name: /Initiate Deployment/ });
    await user.click(initiate);

    expect(onDeploy).toHaveBeenCalledTimes(1);
    const payload = onDeploy.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.appType).toBe('wordpress');
    expect(payload.clusterId).toBe('c1');
    // The database images are part of the payload for an app that has one — a deploy that omits
    // them makes the construct mint its own credential, which is the app-field-plumbing failure.
    expect(payload.pgRepo).toBeTruthy();
    expect(payload.pgTag).toBeTruthy();
  });
});
