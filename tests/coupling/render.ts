import type { Result } from './result.js';

const STYLE = `
:root { --bg: #fafaf9; --panel: #ffffff; --text: #1c1917; --muted: #78716c; --line: #e7e5e4; --bad: #b91c1c; --bad-soft: #fee2e2; --good: #15803d; --good-soft: #dcfce7; --warn: #a16207; --warn-soft: #fef9c3; --accent: #1d4ed8; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #0c0a09; --panel: #1c1917; --text: #f5f5f4; --muted: #a8a29e; --line: #292524; --bad: #f87171; --bad-soft: #450a0a; --good: #4ade80; --good-soft: #052e16; --warn: #facc15; --warn-soft: #422006; --accent: #93c5fd; } }
:root[data-theme="dark"] { --bg: #0c0a09; --panel: #1c1917; --text: #f5f5f4; --muted: #a8a29e; --line: #292524; --bad: #f87171; --bad-soft: #450a0a; --good: #4ade80; --good-soft: #052e16; --warn: #facc15; --warn-soft: #422006; --accent: #93c5fd; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, sans-serif; }
main { max-width: 1200px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 32px 0 8px; }
.muted { color: var(--muted); } code, .mono { font: 12px/1.4 ui-monospace, monospace; overflow-wrap: anywhere; }
.strip { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
.pill { padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); }
.pill.bad { background: var(--bad-soft); color: var(--bad); border-color: transparent; }
.pill.good { background: var(--good-soft); color: var(--good); border-color: transparent; }
.pill.warn { background: var(--warn-soft); color: var(--warn); border-color: transparent; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
.card b { display: block; font-size: 20px; }
.scroll { overflow-x: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-weight: 600; color: var(--muted); cursor: pointer; white-space: nowrap; } td.n { text-align: right; font-variant-numeric: tabular-nums; }
.filters { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; }
input, select { font: inherit; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; }
input[type=search] { flex: 1 1 220px; }
.new { color: var(--bad); font-weight: 600; }
`;

const SCRIPT = `
const result = JSON.parse(document.getElementById('result').textContent);
const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const $ = (id) => document.getElementById(id);
const areaOf = (site) => {
  const parts = site.split(':')[0].split('/');
  if (parts[0] === 'apps' && parts[1] === 'backend' && parts[2] === 'src') return parts.length > 4 ? 'backend/' + parts[3] : 'backend';
  if (parts[0] === 'apps' && parts[1] === 'frontend' && parts[2] === 'src') return parts[3] === 'features' && parts.length > 5 ? 'frontend/' + parts[4] : parts.length > 4 ? 'frontend/' + parts[3] : 'frontend';
  return parts.slice(0, 2).join('/');
};

$('when').textContent = 'commit ' + result.commit + ' · ' + new Date(result.at).toLocaleString() + ' · code ' + result.source;
const strip = [];
if (result.baseline.kind === 'seeded') strip.push(['warn', 'baseline seeded with ' + result.baseline.count + ' breaches']);
else if (result.baseline.kind === 'none') strip.push(['bad', 'no baseline yet']);
else {
  strip.push([result.baseline.added.length ? 'bad' : 'good', result.baseline.added.length + ' new breaches']);
  strip.push([result.baseline.fixed.length ? 'warn' : 'good', result.baseline.fixed.length + ' fixed, to prune']);
}
for (const rule of result.rules.judged) strip.push(['', rule + ' judged']);
for (const skipped of result.rules.skipped) strip.push(['warn', skipped.rule + ' not judged: needs ' + skipped.missing.join(', ')]);
for (const problem of result.problems) strip.push(['warn', problem]);
$('strip').innerHTML = strip.map(([kind, text]) => '<span class="pill ' + kind + '">' + esc(text) + '</span>').join('');

const t = result.totals;
const cards = [['edges', t.edges], ['between areas', t.betweenAreas], ['between processes', t.betweenProcesses], ['covered for real', t.covered], ['no implementation', t.noImplementation], ['calls through any', t.unresolved], ['breaches', result.breaches.length]];
$('cards').innerHTML = cards.map(([label, value]) => '<div class="card"><b>' + esc(value) + '</b><span class="muted">' + esc(label) + '</span></div>').join('');

const newKeys = new Set(result.baseline.kind === 'held' ? result.baseline.added.map((breach) => breach.key + '@' + breach.at) : []);
const table = (host, columns, rows, limit) => {
  let sort = null;
  const draw = () => {
    const sorted = sort === null ? rows() : [...rows()].sort((a, b) => { const x = a[sort.at], y = b[sort.at]; return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * sort.dir; });
    const shown = limit ? sorted.slice(0, limit) : sorted;
    host.innerHTML = '<table><thead><tr>' + columns.map((column, at) => '<th data-at="' + at + '">' + esc(column.label) + '</th>').join('') + '</tr></thead><tbody>'
      + shown.map((row) => '<tr>' + columns.map((column, at) => '<td class="' + (column.cls ?? '') + '">' + (column.html ? column.html(row) : esc(row[at])) + '</td>').join('') + '</tr>').join('')
      + '</tbody></table>' + (limit && sorted.length > limit ? '<p class="muted" style="padding:0 10px">' + (sorted.length - limit) + ' more; narrow the filters</p>' : '');
    host.querySelectorAll('th').forEach((th) => th.onclick = () => { const at = Number(th.dataset.at); sort = sort && sort.at === at ? { at, dir: -sort.dir } : { at, dir: 1 }; draw(); });
  };
  draw();
  return draw;
};

const breachRule = $('breach-rule'), breachArea = $('breach-area'), breachText = $('breach-text'), breachNew = $('breach-new');
const areas = [...new Set(result.breaches.map((breach) => areaOf(breach.at)))].sort();
breachArea.innerHTML = '<option value="">every area</option>' + areas.map((area) => '<option>' + esc(area) + '</option>').join('');
breachRule.innerHTML = '<option value="">every rule</option>' + result.rules.judged.map((rule) => '<option>' + rule + '</option>').join('');
const breachRows = () => result.breaches
  .filter((breach) => (!breachRule.value || breach.rule === breachRule.value) && (!breachArea.value || areaOf(breach.at) === breachArea.value)
    && (!breachNew.checked || newKeys.has(breach.key + '@' + breach.at)) && (!breachText.value || breach.key.toLowerCase().includes(breachText.value.toLowerCase())))
  .map((breach) => [breach.rule, breach.at, breach.key.slice(breach.rule.length + 1), breach.why, newKeys.has(breach.key + '@' + breach.at)]);
const drawBreaches = table($('breaches'), [
  { label: 'rule', html: (row) => '<span class="' + (row[4] ? 'new' : '') + '">' + esc(row[0]) + (row[4] ? ' new' : '') + '</span>' },
  { label: 'at', html: (row) => '<span class="mono">' + esc(row[1]) + '</span>' },
  { label: 'edge', html: (row) => '<span class="mono">' + esc(row[2]) + '</span>' },
  { label: 'why' },
], breachRows, 400);
for (const input of [breachRule, breachArea, breachNew]) input.onchange = drawBreaches;
breachText.oninput = drawBreaches;

table($('areas'), [
  { label: 'area' }, { label: 'edges', cls: 'n' }, { label: 'covered', cls: 'n' }, { label: 'between areas', cls: 'n' },
  { label: 'of those covered', cls: 'n' }, { label: 'with caller', cls: 'n' }, { label: 'no implementation', cls: 'n' },
], () => result.areas.map((area) => [area.area, area.edges, area.covered, area.crossing, area.crossingCovered, area.withCaller, area.noImplementation]));

const edgeText = $('edge-text'), edgeCrosses = $('edge-crosses'), edgeThrough = $('edge-through'), edgeState = $('edge-state');
edgeThrough.innerHTML = '<option value="">every kind</option>' + [...new Set(result.edges.map((edge) => edge.through))].sort().map((kind) => '<option>' + esc(kind) + '</option>').join('');
const edgeRows = () => result.edges
  .filter((edge) => (!edgeCrosses.value || edge.crosses === edgeCrosses.value) && (!edgeThrough.value || edge.through === edgeThrough.value)
    && (!edgeState.value || (edgeState.value === 'uncovered' ? edge.tests === 0 : edge.tests > 0))
    && (!edgeText.value || (edge.from + ' ' + edge.to.join(' ') + ' ' + edge.site).toLowerCase().includes(edgeText.value.toLowerCase())))
  .map((edge) => [edge.site, edge.from, edge.to.join(' | ') || '(none found)', edge.through, edge.lowest ?? '', edge.withCallerAt ?? '', edge.tests]);
const drawEdges = table($('edges'), [
  { label: 'at', html: (row) => '<span class="mono">' + esc(row[0]) + '</span>' },
  { label: 'from', html: (row) => '<span class="mono">' + esc(row[1]) + '</span>' },
  { label: 'to', html: (row) => '<span class="mono">' + esc(row[2]) + '</span>' },
  { label: 'through' }, { label: 'lowest' }, { label: 'with caller' }, { label: 'tests', cls: 'n' },
], edgeRows, 300);
for (const input of [edgeCrosses, edgeThrough, edgeState]) input.onchange = drawEdges;
edgeText.oninput = drawEdges;
`;

export function renderPage(result: Result): string {
  const data = JSON.stringify(result).replace(/</g, `${'\\'}u003c`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Coupling coverage</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Coupling coverage</h1>
<div class="muted" id="when"></div>
<div class="strip" id="strip"></div>
<div class="cards" id="cards"></div>
<h2>Breaches</h2>
<div class="filters">
<input type="search" id="breach-text" placeholder="Find a function or file">
<select id="breach-rule"></select>
<select id="breach-area"></select>
<label><input type="checkbox" id="breach-new"> new only</label>
</div>
<div class="scroll" id="breaches"></div>
<h2>Areas</h2>
<div class="scroll" id="areas"></div>
<h2>Edges</h2>
<div class="filters">
<input type="search" id="edge-text" placeholder="Find a function or file">
<select id="edge-crosses"><option value="">anywhere</option><option value="process">between processes</option><option value="area">between areas</option><option value="none">within an area</option></select>
<select id="edge-through"></select>
<select id="edge-state"><option value="">covered or not</option><option value="uncovered">no test runs it</option><option value="covered">some test runs it</option></select>
</div>
<div class="scroll" id="edges"></div>
</main>
<script type="application/json" id="result">${data}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
