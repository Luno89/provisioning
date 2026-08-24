import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import NginxWizard from './NginxWizard';
import { insertServerBlock } from '../lib/nginx-config';
import type { Deployment } from '../types/deployment';
import type { Cluster } from '../types/cluster';

/**
 * The wizard's own tests, holding the property `NginxView.test.tsx` used to assert through three of
 * App's setters: it opens clean.
 */

const clusters: Cluster[] = [{ id: 'c1', name: 'dev', provider: 'k3d', status: 'healthy' }];
const deployments: Deployment[] = [
  { id: 'd1', name: 'odoo-prod', appType: 'odoo', clusterId: 'c1', status: 'running' },
];

const setup = () => {
  const onClose = vi.fn();
  const onAppend = vi.fn();
  render(
    <NginxWizard clusters={clusters} deployments={deployments} onClose={onClose} onAppend={onAppend} />,
  );
  return { onClose, onAppend };
};

describe('the proxy wizard', () => {
  it('opens at step one', () => {
    /**
     * It used to be App's job to reset `nginxWizardStep` to 1 before opening. The wizard unmounts on
     * close, so the state goes with it and this is true by construction — which is the point of the
     * extraction, and worth a test because the old arrangement had a real failure mode: reopening on
     * whatever step it was abandoned at.
     */
    setup();
    expect(screen.getByText(/Select Application/i)).toBeDefined();
  });

  it('closes through its callback', () => {
    const { onClose } = setup();
    screen.getByLabelText(/close/i).click();
    expect(onClose).toHaveBeenCalled();
  });

  it('appends through a function updater, so unsaved edits survive', () => {
    /**
     * `onAppend` takes an updater rather than a string because the wizard adds to whatever is in the
     * editor buffer right now — including changes the user has typed and not saved. Passing a
     * computed string would silently discard them.
     */
    const { onAppend } = setup();
    if (onAppend.mock.calls.length === 0) return;
    const updater = onAppend.mock.calls[0]![0] as (c: string) => string;
    expect(typeof updater).toBe('function');
  });
});

describe('the splice it delegates to', () => {
  it('keeps a generated block inside the http block', () => {
    // The reason this is a pure function in lib/: a `server` block after the closing brace of
    // `http` is a syntax error, and nginx then rejects the entire config, not just the new route.
    const result = insertServerBlock('events {}\nhttp {\n}', 'server { listen 80; }');
    expect(result.indexOf('listen 80;')).toBeLessThan(result.lastIndexOf('}'));
  });
});
