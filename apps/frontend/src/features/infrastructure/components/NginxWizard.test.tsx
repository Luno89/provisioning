import { fireEvent, render, screen } from '@testing-library/react';
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
    fireEvent.change(screen.getByLabelText(/Application Instance/i), { target: { value: 'd1' } });
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    fireEvent.click(screen.getByRole('button', { name: /Inject into config/ }));
    expect(onAppend).toHaveBeenCalledOnce();
    const updater = onAppend.mock.calls[0]![0] as (current: string) => string;
    const edited = 'events {}\nhttp {\n  # an unsaved edit\n}';
    const appended = updater(edited);
    expect(appended).toContain('# an unsaved edit');
    expect(appended).toContain('odoo-prod.vpn.local');
    expect(appended.indexOf('odoo-prod.vpn.local')).toBeLessThan(appended.lastIndexOf('}'));
  });
});

describe('the splice it delegates to', () => {
  it('keeps a generated block inside the http block', () => {
    const result = insertServerBlock('events {}\nhttp {\n}', 'server { listen 80; }');
    expect(result.indexOf('listen 80;')).toBeLessThan(result.lastIndexOf('}'));
  });
});
