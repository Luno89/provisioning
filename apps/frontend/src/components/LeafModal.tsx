import { useQuery } from '@tanstack/react-query';
import { X, Loader2 } from 'lucide-react';
import LeafDetail from './LeafDetail.js';
import type { Leaf } from './leaf-types.js';
import { listLeaves } from '../api/grove';

export default function LeafModal({ leafId, onClose, onReview }: {
  leafId: string;
  onClose: () => void;
  onReview?: (branchId: string, prompt: string) => void;
}) {
  const { data: leaves, isLoading } = useQuery<Leaf[]>({
    queryKey: ['leaves'],
    queryFn: listLeaves,
  });

  const all = Array.isArray(leaves) ? leaves : [];
  const leaf = all.find((l) => l.id === leafId);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center p-6 z-50 overflow-y-auto" onClick={onClose}>
      <div
        className="bg-[var(--bark-900)] border border-[var(--bark-600)] rounded-2xl w-full max-w-4xl my-8 relative"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-10 p-1.5 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-[var(--bark-700)]"
        >
          <X size={17} />
        </button>

        <div className="p-6">
          {isLoading && <div className="text-slate-500 flex items-center gap-2"><Loader2 className="animate-spin" size={16} /> Loading…</div>}
          {!isLoading && !leaf && (
            <p className="text-slate-500 text-sm">That leaf is no longer there — it may have been deleted.</p>
          )}
          {leaf && (
            <LeafDetail
              leaf={leaf}
              subLeaves={all.filter((l) => l.parentLeafId === leaf.id)}
              all={all}
              {...(onReview ? { onReview: (b: string, p: string) => { onClose(); onReview(b, p); } } : {})}
            />
          )}
        </div>
      </div>
    </div>
  );
}
