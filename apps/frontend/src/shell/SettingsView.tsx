import { useCan, useShellStore } from '../features/platform';
import { ChangePassword, DeleteAccount, TwoFactorSettings } from '../features/accounts';
import { People } from '../features/accounts';
import { Invites } from '../features/accounts';
import { InstanceAddresses } from '../features/accounts';
import { InstanceMove, InstanceUpdates, InstanceWatch } from '../features/instances';
import { Notifications } from '../features/accounts';
import { OtherSessions } from '../features/accounts';
import { DefaultFileServer } from '../features/files'
import { GoogleDriveCard } from '../features/infrastructure';

export default function SettingsView() {
  const user = useShellStore((s) => s.user);
  const can = useCan();

  if (!user) return null;

  return (

  <section className="max-w-xl">
    <header className="mb-10">
      <h2 className="text-3xl font-bold">Settings</h2>
      <p className="text-slate-400">Your account and sign-in, addresses, notifications, backups and the people here.</p>
    </header>
    
    <div className="bg-slate-800 border border-slate-700 rounded-3xl p-8 space-y-6">
      <div>
        <h4 className="text-lg font-bold text-white mb-1">User Account Details</h4>
        <div className="text-sm text-slate-300 space-y-2 mt-3">
          <div><strong>Email:</strong> {user.email}</div>
          <div><strong>Account ID:</strong> <span className="font-mono text-xs">{user.id}</span></div>
          <div><strong>Created:</strong> {user.createdAt ? new Date(user.createdAt).toLocaleDateString() : '—'}</div>
        </div>
      </div>

      <ChangePassword />
      <TwoFactorSettings />
      <OtherSessions />
      {can('change-instance-settings') && <InstanceAddresses />}
      {can('change-instance-settings') && <InstanceUpdates />}
      {can('change-instance-settings') && <InstanceMove />}
      <Notifications />
      <InstanceWatch />
      <DefaultFileServer />
      {can('administer') && <GoogleDriveCard />}

      {can('manage-accounts') && <People />}
      {can('manage-accounts') && <Invites />}

      <DeleteAccount />
    </div>
  </section>
  );
}
