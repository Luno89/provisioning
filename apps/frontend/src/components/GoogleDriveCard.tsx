import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Trash2, Loader2, AlertTriangle, HardDriveDownload, PlayCircle } from 'lucide-react';
import {
  credentialKeys, saveCredentials, deleteCredentials, validateCredentials,
  getDriveStatus, runBackup, driveConnectUrl,
} from '../api/credentials';
import { errorMessage } from '../api/client';
import { driveNoticeFrom } from '../lib/drive-notice';
import type { ValidationResult, BackupResult } from '../types/credentials';

/**
 * Where backups go, and the Google Drive OAuth connection behind it.
 *
 * ── WHY THIS IS NOT PART OF CloudAccounts ──
 * It was, and the two have nothing to do with each other beyond both being reached from the same
 * screen. `CloudAccounts` is a grid of provider credentials; this is one destination with its own
 * lifecycle — connect, set a password, test, run a backup, disconnect. Sharing a file meant sharing
 * a component, so `CloudAccounts` carried eleven `useState` hooks and five mutations that only this
 * markup ever read.
 *
 * Now it owns its own query and its own mutations. `CloudAccounts` holds no Drive state at all,
 * which is the rule: UI state lives in the component that renders the UI.
 */
export default function GoogleDriveCard() {
  const qc = useQueryClient();
  const driveQuery = useQuery({ queryKey: credentialKeys.one('googledrive'), queryFn: getDriveStatus });
  const driveStatus = driveQuery.data ?? null;
  const driveLoading = driveQuery.isPending;

  const refresh = () => qc.invalidateQueries({ queryKey: credentialKeys.all });

  const [driveNotice, setDriveNotice] = useState(() => driveNoticeFrom(window.location.search));
  const [backupPasswordInput, setBackupPasswordInput] = useState('');
  const [driveTestResult, setDriveTestResult] = useState<ValidationResult | null>(null);
  const [confirmDisconnectDrive, setConfirmDisconnectDrive] = useState(false);
  const [backupOutput, setBackupOutput] = useState<BackupResult | null>(null);

  const saveBackupPassword = useMutation({
    mutationFn: (password: string) => saveCredentials('googledrive', { backupPassword: password }),
    onSuccess: async () => {
      await refresh();
      setBackupPasswordInput('');
      setDriveNotice({ kind: 'success', message: 'Backup password saved.' });
    },
    onError: (err) => setDriveNotice({ kind: 'error', message: errorMessage(err) }),
  });

  const testDrive = useMutation({
    mutationFn: () => validateCredentials('googledrive'),
    onSuccess: (result) => setDriveTestResult(result),
    onError: (err) => setDriveTestResult({ valid: false, message: errorMessage(err) }),
  });

  const disconnectDrive = useMutation({
    mutationFn: () => deleteCredentials('googledrive'),
    onSuccess: async () => {
      await refresh();
      setConfirmDisconnectDrive(false);
      setDriveTestResult(null);
      setDriveNotice({ kind: 'success', message: 'Google Drive disconnected.' });
    },
  });

  const backup = useMutation({
    mutationFn: () => runBackup(),
    onSuccess: (result) => setBackupOutput(result),
    onError: (err) => setBackupOutput({ success: false, output: errorMessage(err) }),
  });

  const savingBackupPassword = saveBackupPassword.isPending;
  const testingDrive = testDrive.isPending;
  const runningBackup = backup.isPending;

  const handleSaveBackupPassword = () => saveBackupPassword.mutate(backupPasswordInput);
  const handleTestDrive = () => { setDriveTestResult(null); testDrive.mutate(); };
  const handleDisconnectDrive = () => disconnectDrive.mutate();
  const handleRunBackupNow = () => { setBackupOutput(null); backup.mutate(); };

  return (
    <>
    {/* ── Backup Destinations ── */}
    <header className="mt-14 mb-6 max-w-4xl">
      <h2 className="text-2xl font-bold flex items-center gap-3">
        <HardDriveDownload className="text-blue-500" size={24} />
        Backup Destinations
      </h2>
      <p className="text-slate-400 mt-2 text-sm">
        Where MongoDB, deployed apps' persistent data, and encrypted secrets get backed up.
        Runs daily via a systemd timer, or on demand below.
      </p>
    </header>

    {driveNotice && (
      <div className={`max-w-4xl mb-4 p-4 rounded-2xl text-sm font-semibold flex items-center gap-2 ${
        driveNotice.kind === 'success' ? 'bg-green-500/10 border border-green-500/20 text-green-400' : 'bg-red-500/10 border border-red-500/20 text-red-400'
      }`}>
        {driveNotice.kind === 'success' ? <Check size={16} /> : <AlertTriangle size={16} />}
        <span>{driveNotice.message}</span>
      </div>
    )}

    <div className="max-w-4xl bg-slate-800 border border-slate-700/50 rounded-3xl overflow-hidden relative">
      <div className="h-1 w-full" style={{ backgroundColor: driveStatus?.email ? '#4285F4' : 'transparent' }} />
      <div className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <span className="text-2xl w-10 h-10 flex items-center justify-center rounded-xl" style={{ backgroundColor: '#4285F415', color: '#4285F4' }}>
              ◈
            </span>
            <div>
              <h3 className="font-bold text-white text-lg">Google Drive</h3>
              <div className="flex items-center gap-2 mt-0.5">
                {driveLoading ? (
                  <span className="text-xs text-slate-500 font-semibold">Checking...</span>
                ) : driveStatus?.email ? (
                  <>
                    <div className="w-2 h-2 rounded-full bg-green-500" />
                    <span className="text-xs text-green-400 font-semibold">Connected as {driveStatus.email}</span>
                  </>
                ) : (
                  <>
                    <div className="w-2 h-2 rounded-full bg-slate-500" />
                    <span className="text-xs text-slate-500 font-semibold">Not Connected</span>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {!driveLoading && !driveStatus?.email && (
          <>
            <p className="text-xs text-slate-500 mb-4 leading-relaxed">
              Requires GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in apps/backend/.env (Drive API enabled,
              with http://localhost:3001/api/credentials/googledrive/callback added as an authorized
              redirect URI in Google Cloud Console).
            </p>
            <a
              href={driveConnectUrl()}
              className="inline-flex items-center justify-center gap-2 py-2.5 px-5 text-sm font-bold rounded-xl transition-all text-white"
              style={{ backgroundColor: '#4285F430', color: '#4285F4' }}
            >
              Connect with Google
            </a>
          </>
        )}

        {!driveLoading && driveStatus?.email && (
          <div className="space-y-4">
            <div>
              <div className="flex justify-between items-center mb-2">
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  Backup Encryption Password
                </label>
                {driveStatus.backupPassword && (
                  <span className="text-[11px] text-green-400 font-semibold flex items-center gap-1"><Check size={12} /> Set</span>
                )}
              </div>
              <p className="text-[11px] text-slate-500 mb-2">
                Protects apps/backend/.env in transit and at rest on Drive — losing this password means losing that specific backup (Mongo and app data aren't affected).
              </p>
              <div className="flex gap-2">
                <input
                  type="password"
                  placeholder={driveStatus.backupPassword ? 'Enter a new password to change it' : 'Choose a password'}
                  value={backupPasswordInput}
                  onChange={(e) => setBackupPasswordInput(e.target.value)}
                  className="flex-1 px-4 py-2.5 bg-slate-800/50 border border-white/5 rounded-xl text-white font-mono text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
                <button
                  onClick={handleSaveBackupPassword}
                  disabled={savingBackupPassword || !backupPasswordInput}
                  className="py-2.5 px-4 text-sm font-bold rounded-xl bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 transition-all disabled:opacity-50"
                >
                  {savingBackupPassword ? <Loader2 size={16} className="animate-spin" /> : 'Save'}
                </button>
              </div>
            </div>

            {driveTestResult && (
              <div className={`p-3 rounded-xl text-xs font-semibold flex items-center gap-2 ${
                driveTestResult.valid ? 'bg-green-500/10 border border-green-500/20 text-green-400' : 'bg-red-500/10 border border-red-500/20 text-red-400'
              }`}>
                {driveTestResult.valid ? <Check size={14} /> : <AlertTriangle size={14} />}
                <span>{driveTestResult.message}</span>
              </div>
            )}

            {backupOutput && (
              <div className={`p-3 rounded-xl text-xs font-mono whitespace-pre-wrap max-h-64 overflow-y-auto ${
                backupOutput.success ? 'bg-green-500/5 border border-green-500/20 text-green-300' : 'bg-red-500/5 border border-red-500/20 text-red-300'
              }`}>
                {backupOutput.output || (backupOutput.success ? 'Backup complete.' : 'Backup failed.')}
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => setConfirmDisconnectDrive(true)}
                className="py-2.5 px-4 text-sm font-bold rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-400 transition-all flex items-center gap-2"
              >
                <Trash2 size={16} /> Disconnect
              </button>
              <button
                onClick={handleTestDrive}
                disabled={testingDrive}
                className="flex-1 py-2.5 px-4 text-sm font-bold rounded-xl bg-slate-800 border border-slate-600 hover:bg-slate-700 transition-all text-slate-200 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {testingDrive ? <Loader2 size={16} className="animate-spin" /> : 'Test Connection'}
              </button>
              <button
                onClick={handleRunBackupNow}
                disabled={runningBackup}
                className="flex-1 py-2.5 px-4 text-sm font-bold rounded-xl transition-all text-white disabled:opacity-50 flex items-center justify-center gap-2"
                style={{ backgroundColor: '#4285F4' }}
              >
                {runningBackup ? <Loader2 size={16} className="animate-spin" /> : <><PlayCircle size={16} /> Run Backup Now</>}
              </button>
            </div>
          </div>
        )}
      </div>

      {confirmDisconnectDrive && (
        <div className="absolute inset-0 bg-slate-900/95 backdrop-blur-sm flex flex-col items-center justify-center p-6 z-10 animate-in fade-in duration-150">
          <AlertTriangle className="text-red-500 mb-3" size={32} />
          <h4 className="font-bold text-lg mb-1">Disconnect Google Drive?</h4>
          <p className="text-slate-400 text-sm text-center mb-6">
            Removes the stored refresh token and backup password. Existing backups already on Drive aren't deleted.
          </p>
          <div className="flex gap-3 w-full max-w-xs">
            <button onClick={() => setConfirmDisconnectDrive(false)} className="flex-1 py-2.5 px-4 text-sm font-bold rounded-xl bg-slate-700 hover:bg-slate-600 transition-all">
              Cancel
            </button>
            <button onClick={handleDisconnectDrive} className="flex-1 py-2.5 px-4 text-sm font-bold rounded-xl bg-red-600 hover:bg-red-500 transition-all">
              Disconnect
            </button>
          </div>
        </div>
      )}
    </div>
    </>
  );
}
