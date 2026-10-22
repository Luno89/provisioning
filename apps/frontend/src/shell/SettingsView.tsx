import { useState } from 'react';
import { api, errorMessage } from '../api/client';
import { useShellStore, type AppUser } from '../features/platform';
import { DeleteAccount } from '../components/Account/DeleteAccount';
import { People } from '../components/Account/People';
import { Invites } from '../components/Account/Invites';
import { InstanceAddresses } from '../components/Account/InstanceAddresses';
import { InstanceMove } from '../components/Move/InstanceMove';
import { Notifications } from '../components/Account/Notifications';
import DefaultFileServer from '../components/Files/DefaultFileServer'
import GoogleDriveCard from '../components/GoogleDriveCard';

export default function SettingsView() {
  const user = useShellStore((s) => s.user);
  const setUser = useShellStore((s) => s.setUser);
  const [error, setError] = useState<string | null>(null);

  const update2FASettings = async (
    enabled: boolean, phone?: string, preferredMethod?: 'email' | 'sms',
  ) => {
    try {
      const { data } = await api.post('/auth/2fa/settings', { enabled, phone, preferredMethod });
      const current = useShellStore.getState().user;
      setUser({
        ...(current as AppUser),
        twoFactorEnabled: data.twoFactorEnabled,
        twoFactorPhone: data.twoFactorPhone,
        twoFactorPreferredMethod: data.twoFactorPreferredMethod,
      } as AppUser);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (!user) return null;

  return (

  <section className="max-w-xl">
    {error && (
      <div className="mb-6 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
        {error}
      </div>
    )}
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

      <div className="pt-6 border-t border-slate-700">
        <h4 className="text-lg font-bold text-white mb-4">Two-Factor Authentication (2FA)</h4>
        
        <div className="space-y-4">
          <div className="flex items-center justify-between bg-slate-900/40 p-4 rounded-2xl border border-white/5">
            <div>
              <div className="text-sm font-bold text-white">Enable 2FA Protection</div>
              <div className="text-xs text-slate-400 mt-0.5">Require a one-time passcode on each sign-in attempt.</div>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={user.twoFactorEnabled}
                onChange={(e) => update2FASettings(e.target.checked, user.twoFactorPhone, user.twoFactorPreferredMethod as 'email' | 'sms' | undefined)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
            </label>
          </div>

          {user.twoFactorEnabled && (
            <div className="space-y-4 pt-2">
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Preferred Delivery Method</label>
                <select
                  value={user.twoFactorPreferredMethod || 'email'}
                  onChange={(e) => update2FASettings(user.twoFactorEnabled ?? false, user.twoFactorPhone, e.target.value as 'email' | 'sms')}
                  className="block w-full px-4 py-3 bg-slate-900/50 border border-white/5 rounded-2xl text-white focus:outline-none focus:border-blue-500"
                >
                  <option value="email">Email Notification</option>
                  <option value="sms">SMS Text Message</option>
                </select>
              </div>

              {user.twoFactorPreferredMethod === 'sms' && (
                <div>
                  <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Mobile Phone Number</label>
                  <input
                    type="text"
                    placeholder="e.g. +1234567890"
                    value={user.twoFactorPhone || ''}
                    onChange={(e) => update2FASettings(user.twoFactorEnabled ?? false, e.target.value, user.twoFactorPreferredMethod as 'email' | 'sms' | undefined)}
                    className="block w-full px-4 py-3 bg-slate-900/50 border border-white/5 rounded-2xl text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  />
                  <p className="text-[10px] text-slate-500 mt-1">Include country code prefix (e.g. +1).</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <InstanceAddresses />
      <InstanceMove />
      <Notifications />
      <DefaultFileServer />
      <GoogleDriveCard />

      {user.isAdmin && user.holdsAccounts !== false && <People />}
      {user.isAdmin && user.holdsAccounts !== false && <Invites />}

      <DeleteAccount />
    </div>
  </section>
  );
}
