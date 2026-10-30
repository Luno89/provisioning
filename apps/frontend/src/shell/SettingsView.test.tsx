import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const allowed = new Set<string>();

vi.mock('../features/platform', () => ({
  useCan: () => (action: string) => allowed.has(action),
  useShellStore: (pick: (state: { user: { id: string; email: string; twoFactorEnabled: boolean } }) => unknown) =>
    pick({ user: { id: 'u1', email: 'person@example.com', twoFactorEnabled: false } }),
}));
vi.mock('../features/accounts', () => ({
  DeleteAccount: () => <div>Delete account</div>,
  People: () => <div>People</div>,
  Invites: () => <div>Invites</div>,
  InstanceAddresses: () => <div>Addresses</div>,
  Notifications: () => <div>Notifications</div>,
  OtherSessions: () => <div>Other sessions</div>,
}));
vi.mock('../features/instances', () => ({
  InstanceMove: () => <div>Move</div>,
  InstanceUpdates: () => <div>Updates</div>,
  InstanceWatch: () => <div>Watch</div>,
}));
vi.mock('../features/files', () => ({ DefaultFileServer: () => <div>Files</div> }));
vi.mock('../features/infrastructure', () => ({ GoogleDriveCard: () => <div>Backups</div> }));

import SettingsView from './SettingsView';

describe('Settings shows the operator sections only to the operator', () => {
  beforeEach(() => allowed.clear());

  it('hides backups, people and invites from someone who may not administer', () => {
    render(<SettingsView />);
    expect(screen.queryByText('Backups')).toBeNull();
    expect(screen.queryByText('People')).toBeNull();
    expect(screen.queryByText('Invites')).toBeNull();
    expect(screen.getByText('Notifications')).toBeTruthy();
  });

  it('shows backups to the operator', () => {
    allowed.add('administer');
    allowed.add('manage-accounts');
    render(<SettingsView />);
    expect(screen.getByText('Backups')).toBeTruthy();
    expect(screen.getByText('People')).toBeTruthy();
  });
});
