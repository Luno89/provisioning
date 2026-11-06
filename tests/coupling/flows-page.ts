import { CONCEPTS } from './concepts.js';
import { mermaidOf, type Change, type Implementation, type Snapshot } from './flows.js';

const escaped = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const LABELS: Record<string, string> = Object.fromEntries(CONCEPTS.map((concept) => [concept.id, concept.label]));

const STYLE = `
:root { --bg: #f5f6f8; --surface: #ffffff; --fg: #1c2330; --muted: #5b6577; --line: #d8dce4; --accent: #2a6b5f; --soft: #e3efec;
  --display: "Sora", "Segoe UI", system-ui, sans-serif; --body: "Source Sans 3", "Segoe UI", system-ui, sans-serif; --mono: "JetBrains Mono", ui-monospace, Menlo, monospace; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #12161c; --surface: #1a2028; --fg: #e2e6ed; --muted: #98a2b2; --line: #2b3340; --accent: #6cc6b4; --soft: #17332d; color-scheme: dark; } }
:root[data-theme="dark"] { --bg: #12161c; --surface: #1a2028; --fg: #e2e6ed; --muted: #98a2b2; --line: #2b3340; --accent: #6cc6b4; --soft: #17332d; color-scheme: dark; }
* { box-sizing: border-box; }
body { background: var(--bg); color: var(--fg); font-family: var(--body); font-size: 16px; line-height: 1.55;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
main { max-width: 1100px; margin: 0 auto; padding-block: 36px 72px; }
h1 { font-family: var(--display); font-size: clamp(28px, 4.5vw, 38px); margin: 0 0 8px; text-wrap: balance; }
h2 { font-family: var(--display); font-size: 23px; margin: 44px 0 10px; text-wrap: balance; }
h3 { font-family: var(--display); font-size: 17px; margin: 22px 0 6px; }
.muted { color: var(--muted); }
code { font-family: var(--mono); font-size: .85em; background: var(--soft); padding: 1px 5px; border-radius: 4px; overflow-wrap: anywhere; }
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 10px 14px; margin: 12px 0; min-width: 0; }
.diagram { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
td.num { font-variant-numeric: tabular-nums; text-align: right; }
.table { overflow-x: auto; }
details summary { cursor: pointer; font-weight: 600; }
.added { color: var(--accent); }
`;

const flowSection = (name: string, snapshot: Snapshot): string => {
  const flow = snapshot.flows[name]!;
  const touched = flow.files.files.filter((node) => node.concepts.length > 0).length;
  return `<section id="flow-${escaped(name)}">
<h3>${escaped(flow.title)}</h3>
<p class="muted">${flow.files.files.length} files, ${touched} of them touch the outside world${flow.missing.length > 0 ? `. <strong>Entry not found:</strong> ${flow.missing.map((entry) => `<code>${escaped(entry)}</code>`).join(', ')}` : ''}.</p>
<div class="panel diagram"><pre class="mermaid">${escaped(mermaidOf(flow.files, LABELS))}</pre></div>
<details><summary>Where it touches the outside world (${flow.touches.length})</summary><div class="table"><table><tbody>${flow.touches.map((touch) => {
    const [concept, ...rest] = touch.split(' ');
    return `<tr><td>${escaped(LABELS[concept ?? ''] ?? concept ?? '')}</td><td><code>${escaped(rest.join(' '))}</code></td></tr>`;
  }).join('')}</tbody></table></div></details>
${flow.gaps.length > 0 ? `<details open><summary>Where the map loses the trail (${flow.gaps.length})</summary><p class="muted">The code goes on from here, but the graph can't tell where: a workflow started by a name only known at run time, or a call through an interface nothing in the code implements.</p><div class="table"><table><tbody>${flow.gaps.map((gap) => {
    const [through, ...at] = gap.split(' ');
    return `<tr><td>${escaped(through === 'temporal' ? 'starts a workflow named at run time' : `calls through ${through ?? ''} with no implementation found`)}</td><td><code>${escaped(at.join(' '))}</code></td></tr>`;
  }).join('')}</tbody></table></div></details>` : ''}
</section>`;
};

const indexSection = (concept: string, implementations: readonly Implementation[]): string => `<section id="concept-${escaped(concept)}">
<h3>${escaped(LABELS[concept] ?? concept)} <span class="muted">· ${new Set(implementations.map((entry) => entry.unit)).size} functions</span></h3>
<details><summary>Every function that does it, and how many call it</summary><div class="table"><table><thead><tr><th>Function</th><th>Line</th><th>Callers</th></tr></thead><tbody>${implementations.map((entry) =>
  `<tr><td><code>${escaped(entry.unit)}</code></td><td class="num">${entry.line}</td><td class="num">${entry.callers}</td></tr>`).join('')}</tbody></table></div></details>
</section>`;

export function changesText(changes: readonly Change[]): string {
  if (changes.length === 0) return 'No flow or concept changed.';
  const byWhere = new Map<string, Change[]>();
  for (const change of changes) byWhere.set(change.where, [...(byWhere.get(change.where) ?? []), change]);
  return [...byWhere].map(([where, list]) => [`${where}:`, ...list.map((change) => `  ${change.kind === 'added' ? '+' : '-'} ${change.what}`)].join('\n')).join('\n');
}

export function flowsPage(snapshot: Snapshot, index: Record<string, readonly Implementation[]>, changes?: readonly Change[]): string {
  return `<title>Koala Flow Maps</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Sora:wght@600&family=Source+Sans+3:wght@400;600&family=JetBrains+Mono&display=swap">
<style>${STYLE}</style>
<main>
<h1>Koala flow maps</h1>
<p class="muted">Generated from the coupling graph at commit <code>${escaped(snapshot.commit)}</code> by <code>npm run flows</code>. Each map starts where the browser starts the flow and keeps only the paths that reach the outside world: obtaining a kubeconfig, running kubectl or helm, handing work to another process, reading configuration, calling another service. Boxes are files, grouped by area; a dashed box touches the outside world; the thick box is where the flow starts; a box marked "map stops here" is where the graph loses the trail. A shell script shows as one box: what it runs inside is not mapped.</p>
${changes ? `<h2>What changed</h2><div class="panel"><pre>${escaped(changesText(changes))}</pre></div>` : ''}
<h2>The v1 flows</h2>
${Object.keys(snapshot.flows).map((name) => flowSection(name, snapshot)).join('\n')}
<h2>Every implementation of each concept</h2>
<p class="muted">A concept should have one implementation that everything else calls. Each row is a function whose own code does it.</p>
${Object.entries(index).map(([concept, implementations]) => indexSection(concept, implementations)).join('\n')}
</main>`;
}
