/**
 * The koala, drawn in SVG rather than shipped as a GIF.
 *
 * Authored in code on purpose: a GIF would be a binary blob nobody can adjust, it would need
 * hosting or committing, and hotlinking someone else's is fragile and a licensing question. This
 * scales, themes with the palette, weighs nothing, and can react to state — a GIF cannot blink
 * faster because something is running.
 *
 * `mood` drives the animation rather than swapping assets, so a caller says what is happening and
 * the koala works out how to look about it.
 */

export type KoalaMood = 'idle' | 'thinking' | 'happy' | 'sad';

export function Koala({ size = 64, mood = 'idle', className = '' }: {
  size?: number;
  mood?: KoalaMood;
  className?: string;
}) {
  // Thinking chews faster; sad droops. Kept as data so the SVG below stays readable.
  const chew = mood === 'thinking' ? '0.6s' : mood === 'happy' ? '1.4s' : '3s';
  const earFur = 'var(--koala-fur-dark, #6b7280)';
  const fur = 'var(--koala-fur, #9ca3af)';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={className}
      role="img"
      aria-label={`Koala, ${mood}`}
    >
      {/* Ears — the silhouette that makes it read as a koala at 16px as well as 160px. */}
      <circle cx="22" cy="30" r="16" fill={earFur} />
      <circle cx="22" cy="30" r="9" fill="var(--koala-ear-inner, #d1a3a3)" opacity="0.6" />
      <circle cx="78" cy="30" r="16" fill={earFur} />
      <circle cx="78" cy="30" r="9" fill="var(--koala-ear-inner, #d1a3a3)" opacity="0.6" />

      <ellipse cx="50" cy="52" rx="30" ry="28" fill={fur} />

      {/* Eyes. The blink is a scaleY on a group so it reads as lids rather than dots vanishing. */}
      <g>
        <ellipse cx="39" cy="47" rx="4" ry="5" fill="#1f2937">
          <animate attributeName="ry" values="5;5;0.5;5;5" dur="5s" repeatCount="indefinite" />
        </ellipse>
        <ellipse cx="61" cy="47" rx="4" ry="5" fill="#1f2937">
          <animate attributeName="ry" values="5;5;0.5;5;5" dur="5s" repeatCount="indefinite" />
        </ellipse>
      </g>

      {/* Nose — the big leathery one is most of the character. */}
      <ellipse cx="50" cy="60" rx="11" ry="8" fill="#374151" />
      <ellipse cx="46" cy="57" rx="3" ry="2" fill="#4b5563" opacity="0.7" />

      {/* Mouth: chewing, because a koala that never eats is a bear. */}
      <path
        d={mood === 'sad' ? 'M 43 72 Q 50 68 57 72' : 'M 43 70 Q 50 75 57 70'}
        stroke="#374151"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      >
        {mood !== 'sad' && (
          <animate
            attributeName="d"
            values="M 43 70 Q 50 75 57 70; M 43 70 Q 50 71 57 70; M 43 70 Q 50 75 57 70"
            dur={chew}
            repeatCount="indefinite"
          />
        )}
      </path>

      {/* A eucalyptus sprig, only while there is something to chew on. */}
      {(mood === 'thinking' || mood === 'happy') && (
        <g>
          <path d="M 70 74 Q 78 70 84 62" stroke="var(--leaf-stem, #4d7c0f)" strokeWidth="2" fill="none" strokeLinecap="round" />
          <ellipse cx="84" cy="61" rx="6" ry="3.5" fill="var(--leaf, #65a30d)" transform="rotate(-35 84 61)">
            <animateTransform
              attributeName="transform"
              type="rotate"
              values="-35 84 61; -28 84 61; -35 84 61"
              dur="2s"
              repeatCount="indefinite"
              additive="sum"
            />
          </ellipse>
          <ellipse cx="76" cy="67" rx="5" ry="3" fill="var(--leaf-light, #84cc16)" transform="rotate(-20 76 67)" />
        </g>
      )}
    </svg>
  );
}

/**
 * A slot for a real GIF, falling back to the SVG.
 *
 * Exists because animated art is something to drop in later without touching layout: point `src`
 * at a file in /public and it takes over, leave it unset and the koala above stands in. The
 * fallback is the default rather than a broken image, so nothing looks broken before the art
 * exists.
 */
export function KoalaSpot({ src, alt, size = 96, mood = 'idle', className = '' }: {
  src?: string;
  alt?: string;
  size?: number;
  mood?: KoalaMood;
  className?: string;
}) {
  if (src) {
    return <img src={src} alt={alt ?? 'Koala'} width={size} height={size} className={`rounded-2xl ${className}`} />;
  }
  return <Koala size={size} mood={mood} className={className} />;
}
