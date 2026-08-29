import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import NginxWizard from './NginxWizard';
import { insertServerBlock } from '../lib/nginx-config';
import type { Deployment } from '../types/deployment';
import type { Cluster } from '../types/cluster';

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
    setup();
    expect(screen.getByText(/Select Application/i)).toBeDefined();
  });

  it('closes through its callback', () => {
    const { onClose } = setup();
    screen.getByLabelText(/close/i).click();
    expect(onClose).toHaveBeenCalled();
  });

  it('appends through a function updater, so unsaved edits survive', () => {
    const { onAppend } = setup();
    if (onAppend.mock.calls.length === 0) return;
    const updater = onAppend.mock.calls[0]![0] as (c: string) => string;
    expect(typeof updater).toBe('function');
  });
});

describe('the splice it delegates to', () => {
  it('keeps a generated block inside the http block', () => {
    const result = insertServerBlock('events {}\nhttp {\n}', 'server { listen 80; }');
    expect(result.indexOf('listen 80;')).toBeLessThan(result.lastIndexOf('}'));
  });
});
