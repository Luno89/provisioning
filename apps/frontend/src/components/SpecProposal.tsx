import { Boxes, HardDrive, KeyRound } from 'lucide-react';

/**
 * A new deployable app type, waiting for someone to agree it should exist.
 *
 * ── WHAT ACCEPTING THIS DOES, AND DOES NOT ──
 * It adds an app type to the catalogue. It deploys nothing. That distinction is the whole reason
 * this is a card rather than a button: a spec runs containers in your cluster, and the moment
 * before it exists is the cheapest place to look at it.
 *
 * So the card shows what will actually run — image, ports, disks, which values are generated — and
 * not the raw JSON. The JSON is the thing a reader skims and approves without reading; naming the
 * disk and the port is what makes "wait, why does a cache need 100Gi" a thought someone has.
 *
 * ── WHY ITS OWN FILE ──
 * KoalaChat already holds a thread list, a transcript, a composer and a proposal list. Adding
 * seventy lines of card to it is the habit that produced a 3,000-line App.
 */

export interface Spec {
  id: string;
  image: string;
  ports?: { name: string; port: number }[];
  volumes?: { path: string; size: string }[];
  env?: { name: string; generate?: string }[];
  resources?: { limits?: { cpu?: string; memory?: string } };
}

export default function SpecProposal({ spec, accepted, onAccept, pending }: {
  spec: Spec;
  /** Already in the catalogue — the card says so rather than offering to add it twice. */
  accepted?: boolean;
  onAccept: () => void;
  pending?: boolean;
}) {
  const generated = (spec.env ?? []).filter((e) => e.generate);

  return (
    <div className="max-w-[85%] rounded-2xl border border-[var(--leaf)]/40 bg-[var(--leaf)]/5 px-4 py-3">
      <div className="flex items-center gap-2 mb-1.5">
        <Boxes size={14} className="text-[var(--leaf)]" />
        <span className="text-[13px] font-bold text-slate-100">{spec.id}</span>
        <span className="text-[11px] text-slate-500 font-mono">{spec.image}</span>
      </div>

      {/* What will actually run, rather than the JSON — which is the thing a reader approves
          without reading. */}
      <dl className="text-[12px] text-slate-300 space-y-0.5 mb-2">
        {spec.ports?.length ? (
          <div className="flex gap-2">
            <dt className="text-slate-500 w-16 shrink-0">Ports</dt>
            <dd>{spec.ports.map((p) => `${p.port} (${p.name})`).join(', ')}</dd>
          </div>
        ) : null}
        {spec.volumes?.length ? (
          <div className="flex gap-2">
            <dt className="text-slate-500 w-16 shrink-0 flex items-center gap-1"><HardDrive size={11} /> Disk</dt>
            <dd>{spec.volumes.map((v) => `${v.size} at ${v.path}`).join(', ')}</dd>
          </div>
        ) : null}
        {spec.resources?.limits ? (
          <div className="flex gap-2">
            <dt className="text-slate-500 w-16 shrink-0">Limits</dt>
            <dd>{[spec.resources.limits.memory, spec.resources.limits.cpu].filter(Boolean).join(' / ')}</dd>
          </div>
        ) : null}
        {generated.length > 0 && (
          <div className="flex gap-2">
            <dt className="text-slate-500 w-16 shrink-0 flex items-center gap-1"><KeyRound size={11} /> Secrets</dt>
            {/* Named so it is visible that a credential exists and that nothing here chose it —
                the platform mints these and injects them, and Koala never sees the value. */}
            <dd>{generated.map((e) => e.name).join(', ')} — generated on deploy</dd>
          </div>
        )}
      </dl>

      {accepted ? (
        <p className="text-[12px] text-[var(--leaf)]">Added — {spec.id} can now be deployed.</p>
      ) : (
        <>
          <button
            onClick={onAccept}
            disabled={pending}
            className="px-3 py-1.5 rounded-lg bg-[var(--leaf-stem)] text-white text-[12px] font-semibold hover:opacity-90 disabled:opacity-50"
          >
            Add to the catalogue
          </button>
          {/* Said plainly: accepting is not deploying, and the difference matters to anyone
              deciding whether to click. */}
          <p className="text-[11px] text-slate-500 mt-1">
            Makes it deployable. Nothing is deployed by adding it.
          </p>
        </>
      )}
    </div>
  );
}
