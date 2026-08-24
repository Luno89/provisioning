/**
 * Inserting a generated server block into an nginx config.
 *
 * ── WHY THIS IS NOT THREE LINES IN THE WIZARD ──
 * It was, closing over the editor's buffer. `server { … }` has to go INSIDE the `http { … }` block —
 * appended after the closing brace it is a syntax error, and nginx refuses to start with the whole
 * config rejected rather than just the new route. So the wizard found the last `}` and spliced
 * before it, which is correct and impossible to check without rendering a wizard and clicking to
 * step three.
 *
 * Falls back to appending when there is no `http {` at all — a config that does not have one is not
 * a config this can reason about, and refusing to add anything would leave the user with a wizard
 * that silently does nothing.
 */
export function insertServerBlock(config: string, block: string): string {
  if (config.includes('http {')) {
    const lastBrace = config.lastIndexOf('}');
    if (lastBrace !== -1) {
      return config.slice(0, lastBrace) + block + '\n' + config.slice(lastBrace);
    }
  }
  return `${config}\n${block}`;
}
