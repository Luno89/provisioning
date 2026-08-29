import { Boxes, HardDrive, KeyRound } from 'lucide-react';

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
          <p className="text-[11px] text-slate-500 mt-1">
            Makes it deployable. Nothing is deployed by adding it.
          </p>
        </>
      )}
    </div>
  );
}
