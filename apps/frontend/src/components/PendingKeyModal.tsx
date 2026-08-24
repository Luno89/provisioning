import { Loader2, Shield } from 'lucide-react';

/**
 * The public key a bring-your-own machine has to authorise before it can be provisioned.
 *
 * ── WHY IT BLOCKS ──
 * A `remote` cluster is a machine the user already owns, sitting behind their own NAT. Nothing can
 * SSH inward, so provisioning generates a keypair and waits: the cluster sits in `awaiting-key`
 * until this key is in the machine's `authorized_keys` and the user says go. That state is terminal
 * until then, which is why the reconciliation loop leaves it alone rather than treating it as a
 * stalled provision.
 */
export interface PendingKeyModalProps {
  /** The cluster waiting, and the key it generated. */
  pending: { id: string; publicKey: string };
  onDismiss: () => void;
  /**
   * Starts provisioning once the key is installed.
   *
   * App owns the mutation rather than this modal, because succeeding means opening the log modal on
   * the new cluster — which is App's to open. This stays presentational.
   */
  onStart: (id: string) => void;
  starting: boolean;
  /** Why starting failed, if it did. Read through `errorMessage` by the caller. */
  startError?: string | null;
}

export default function PendingKeyModal({
  pending, onDismiss, onStart, starting, startError,
}: PendingKeyModalProps) {
  const pendingKey = pending;
  const setPendingKey = (v: null) => { if (v === null) onDismiss(); };
  return (

    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <div className="bg-slate-800 border border-slate-700 rounded-3xl p-10 w-full max-w-2xl shadow-2xl">
        <h3 className="text-2xl font-bold mb-2">Authorise this key</h3>
        <p className="text-sm text-slate-400 mb-6">
          Run this on the machine, then start provisioning. This is a public key — it grants
          access <em>to</em> that machine and is safe to paste anywhere.
        </p>

        <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 mb-3">
          <code className="text-[11px] text-slate-300 font-mono break-all leading-relaxed">
            mkdir -p ~/.ssh &amp;&amp; echo '{pendingKey.publicKey}' &gt;&gt; ~/.ssh/authorized_keys
          </code>
        </div>
        <button
          onClick={() => navigator.clipboard.writeText(`mkdir -p ~/.ssh && echo '${pendingKey.publicKey}' >> ~/.ssh/authorized_keys`)}
          className="text-[11px] text-slate-500 hover:text-white transition-colors mb-6"
        >
          Copy command
        </button>

        <div className="bg-slate-900/50 border border-slate-700/50 rounded-2xl p-4 mb-8 flex items-start gap-3">
          <Shield className="text-blue-400 flex-shrink-0 mt-0.5" size={16} />
          <p className="text-[11px] text-slate-400 leading-relaxed">
            The matching private key was generated on the platform and never sent to your
            browser. It is stored encrypted and used only to install k3s and, if you destroy
            the cluster, to remove it.
          </p>
        </div>

        <div className="flex gap-4">
          <button
            onClick={() => setPendingKey(null)}
            className="px-6 py-3 rounded-xl bg-slate-700 hover:bg-slate-600 transition-all text-sm font-bold"
          >
            Later
          </button>
          <button
            onClick={() => onStart(pendingKey.id)}
            disabled={starting}
            className="flex-1 px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 transition-all text-sm font-bold flex items-center justify-center gap-2"
          >
            {starting ? <Loader2 className="animate-spin" size={16} /> : "I've added it — start provisioning"}
          </button>
        </div>
        {startError && (
          <p className="text-[11px] text-red-400 mt-3">
            {startError}
          </p>
        )}
      </div>
    </div>
  );
}
