import { KoalaSpot } from './Koala.js';

/**
 * What a chat shows while it is fetching.
 *
 * Switching conversations used to render nothing at all — the thread emptied and stayed empty
 * until the fetch returned, which reads as a freeze rather than as loading.
 */
export function KoalaLoading({
  label = 'Loading…',
  size = 56,
}: {
  label?: string;
  size?: number;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col items-center justify-center gap-3 py-16 text-center"
    >
      <KoalaSpot size={size} mood="thinking" className="koala-bob" />
      <p className="text-xs text-slate-500">{label}</p>
    </div>
  );
}

export default KoalaLoading;
