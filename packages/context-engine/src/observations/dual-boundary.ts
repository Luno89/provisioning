export interface DualBoundaryOptions {
  maxChars?: number;
  headRatio?: number;
  omissionNotice?: (omittedChars: number) => string;
}

const DEFAULT_MAX_CHARS = 30_000;
const DEFAULT_HEAD_RATIO = 0.20;

/**
 * Dual-boundary clipping preserves both the head and the tail of verbose outputs.
 *
 * For command execution, compiler output, and test runs:
 * - The head contains invocation parameters, environmental setup, and initial status.
 * - The tail contains the crucial exit code, assertion failures, stack traces, and summary.
 *
 * Head-only slicing (e.g. .slice(0, 30_000)) destroys the actual failure message.
 * Tail-only slicing destroys the invocation context.
 * Dual-boundary preserves both with a clean omission marker in the middle.
 */
export function clampDualBoundary(
  text: string,
  options: DualBoundaryOptions = {},
): string {
  if (!text) return '';
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  if (text.length <= maxChars) return text;

  const headRatio = Math.max(0, Math.min(1, options.headRatio ?? DEFAULT_HEAD_RATIO));
  const headChars = Math.floor(maxChars * headRatio);
  const tailChars = maxChars - headChars;
  const omitted = text.length - maxChars;

  const notice = options.omissionNotice
    ? options.omissionNotice(omitted)
    : `\n\n... [${omitted.toLocaleString()} characters omitted from middle — inspect specific file or run with filters if more detail is needed] ...\n\n`;

  if (headChars <= 0) {
    return `... [${omitted.toLocaleString()} characters omitted from start] ...\n\n${text.slice(-tailChars)}`;
  }
  if (tailChars <= 0) {
    return `${text.slice(0, headChars)}\n\n... [${omitted.toLocaleString()} characters omitted from end] ...`;
  }

  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);

  return `${head}${notice}${tail}`;
}
