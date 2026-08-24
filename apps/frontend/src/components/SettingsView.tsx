import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../api/client';
import { useShellStore, type AppUser } from '../stores/shell';

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Mirrors `InviteMetadata` in `apps/backend/src/lib/types.ts`; the backend is the authority. Note
 * that `id` and `code` hold the same value there — the code is its own primary key.
 */
interface Invite {
  id: string;
  code: string;
  createdBy: string;
  createdAt: string;
  /** The user who registered with it. Absent means unused. */
  usedBy?: string;
  usedAt?: string;
}

/**
 * Account security: two-factor settings, and what the account is.
 *
 * ── THE LAST INLINE SCREEN ──
 * Thirteen of the fourteen views had been extracted; this one was still rendered inside App's own
 * return, which is why it could only be reached in a test by mounting the whole application.
 *
 * It reads the user from the shell store rather than taking it as a prop, and owns the mutation
 * that changes it — App was holding `update2FASettings` purely because the markup lived there.
 */
export default function SettingsView() {
  const qc = useQueryClient();
  const user = useShellStore((s) => s.user);
  const setUser = useShellStore((s) => s.setUser);
  const [error, setError] = useState<string | null>(null);

  /**
   * Invite codes, for an admin. Native registration is invite-gated, and so is social login — the
   * code rides through the OAuth roundtrip in `state`, so a new account created that way is gated
   * exactly like a native one rather than being a silent bypass of it.
   */
  const { data: invites = [] } = useQuery({
    queryKey: ['invites'],
    queryFn: () => api.get<Invite[]>('/admin/invites').then((r) => r.data),
    enabled: user?.isAdmin === true,
  });
  const mintInvite = useMutation({
    mutationFn: () => api.post('/admin/invites', {}).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invites'] }),
  });

  /**
   * Writes the 2FA settings and folds the response back into the session.
   *
   * Reads the current user through `getState()` rather than closing over it: this is a plain
   * setter, not a React dispatch, so there is no updater form to pass.
   */
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
    {/*
      * A failed 2FA change used to `console.error` and nothing else, so the toggle appeared to
      * work while the server had rejected it. That is worth showing.
      */}
    {error && (
      <div className="mb-6 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
        {error}
      </div>
    )}
    <header className="mb-10">
      <h2 className="text-3xl font-bold">Security & Settings</h2>
      <p className="text-slate-400">Configure authentication and two-factor (2FA) mechanisms.</p>
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

      <div className="pt-6 border-t border-slate-700">
        <h4 className="text-lg font-bold text-white mb-1">Cluster Service Access</h4>
        <p className="text-xs text-slate-400 mb-4">
          How each auto-provisioned service on your clusters is secured. No credentials are ever shown here —
          Grafana and Gitea log you in automatically (a real session, password never sent to your browser) when
          you click "Open Dashboard" on the Cluster Services page.
        </p>
        <div className="space-y-2">
          {[
            { name: 'Grafana', detail: 'Signed in automatically as admin.', status: 'Auto-login', ok: true },
            { name: 'Gitea', detail: 'Signed in automatically as provisioning-bot.', status: 'Auto-login', ok: true },
            { name: 'Prometheus', detail: 'No login screen — open by design (local dev).', status: 'No auth', ok: false },
            { name: 'Traefik Dashboard', detail: 'Runs in insecure/unauthenticated mode — local dev only.', status: 'No auth', ok: false },
            { name: 'Alertmanager', detail: 'No login screen — open by design (local dev).', status: 'No auth', ok: false },
            { name: 'Loki', detail: 'No dashboard of its own — browse logs via Grafana Explore.', status: 'N/A', ok: false },
          ].map((s) => (
            <div key={s.name} className="flex items-center justify-between bg-slate-900/40 p-4 rounded-2xl border border-white/5">
              <div>
                <div className="text-sm font-bold text-white">{s.name}</div>
                <div className="text-xs text-slate-400 mt-0.5">{s.detail}</div>
              </div>
              <span className={`text-[10px] font-bold px-3 py-1 rounded-full uppercase ${s.ok ? 'bg-green-500/10 text-green-500' : 'bg-slate-500/10 text-slate-400'}`}>
                {s.status}
              </span>
            </div>
          ))}
        </div>
      </div>

      {user.isAdmin && (
        <div className="pt-6 border-t border-slate-700">
          <div className="flex items-center justify-between mb-1">
            <h4 className="text-lg font-bold text-white">Invites</h4>
            <button
              onClick={() => mintInvite.mutate()}
              disabled={mintInvite.isPending}
              className="text-xs font-bold px-3 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 transition-colors cursor-pointer disabled:opacity-50"
            >
              {mintInvite.isPending ? 'Generating...' : 'Generate Invite'}
            </button>
          </div>
          <p className="text-xs text-slate-400 mb-4">
            This platform is invite-only. Share an unused code with anyone you want to give an account.
          </p>
          <div className="space-y-2">
            {invites.length === 0 && (
              <div className="text-sm text-slate-500 italic">No invites generated yet.</div>
            )}
            {[...invites].reverse().map((inv) => (
              <div key={inv.id} className="flex items-center justify-between bg-slate-900/40 p-4 rounded-2xl border border-white/5">
                <div>
                  <div className="text-sm font-mono font-bold text-white">{inv.code}</div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    {inv.usedBy ? `Used ${new Date(inv.usedAt ?? inv.createdAt).toLocaleDateString()}` : `Created ${new Date(inv.createdAt).toLocaleDateString()}`}
                  </div>
                </div>
                <span className={`text-[10px] font-bold px-3 py-1 rounded-full uppercase ${inv.usedBy ? 'bg-slate-500/10 text-slate-400' : 'bg-green-500/10 text-green-500'}`}>
                  {inv.usedBy ? 'Used' : 'Unused'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  </section>
  );
}
