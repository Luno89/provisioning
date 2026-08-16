import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { X, Loader2 } from 'lucide-react';
import LeafDetail from './LeafDetail.js';
import type { Leaf } from './leaf-types.js';

/**
 * A leaf opened from the board.
 *
 * ── WHY IT IS A SHELL AND NOT A SECOND SURFACE ──
 * This used to be `LeafTrace`, and it was the other half of the split: the board could show every
 * turn a leaf took but not what it was asked, what it claimed, or how it failed, while the sidebar
 * pane could show all of that and no turns. Two surfaces, each missing the other's half, reached by
 * unrelated routes.
 *
 * So it holds no content of its own. It fetches the full leaf — the board's own payload is trimmed
 * for cards and lacks the body, the summary and the attempts — and hands it to the one component
 * that knows how to describe a leaf.
 *
 * The list is already in the cache whenever the workspace is open, so this is usually free.
 */
export default function LeafModal({ apiBase, leafId, onClose, onReview }: {
  apiBase: string;
  leafId: string;
  onClose: () => void;
  onReview?: (branchId: string, prompt: string) => void;
}) {
  const { data: leaves, isLoading } = useQuery<Leaf[]>({
    queryKey: ['leaves'],
    queryFn: () => axios.get(`${apiBase}/leaves`, { withCredentials: true }).then((r) => r.data),
  });

  // Defensive: a malformed or empty response must not take the panel down with it. Reading `.find`
  // off a non-array is how a bad payload became a blank screen rather than a message.
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
              apiBase={apiBase}
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
