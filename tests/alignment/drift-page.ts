import type { Answer } from './answers.js';
import type { Decision } from './decisions.js';
import type { Finding, FindingKind } from './drift.js';
import type { Flow } from './flow-spec.js';
import type { StepTrace } from './trace.js';

export interface DriftView {
  flows: readonly Flow[];
  decisions: readonly Decision[];
  traces: ReadonlyMap<string, StepTrace>;
  findings: readonly Finding[];
  answers: readonly Answer[];
  commit: string;
}

export const FOR_THE_OWNER: ReadonlySet<FindingKind> = new Set(['undecided-branch', 'two-paths', 'misquote', 'assumption', 'missing']);

export const KIND_LABELS: Record<FindingKind, string> = {
  'undecided-branch': 'Branch no decision settles',
  'two-paths': 'Two paths for one job',
  misquote: 'Your words, misquoted',
  assumption: 'Rests on my assumption',
  missing: 'No code, or the map cannot follow it',
  'decided-not-done': 'Decided, not done yet',
};

const json = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');

export function driftPage(view: DriftView): string {
  const data = {
    commit: view.commit,
    flows: view.flows,
    decisions: Object.fromEntries(view.decisions.map((decision) => [decision.id, { subject: decision.subject, reading: decision.reading, words: decision.words }])),
    traces: Object.fromEntries(view.traces),
    findings: view.findings,
    answers: Object.fromEntries(view.answers.map((answer) => [answer.finding, answer])),
    forOwner: [...FOR_THE_OWNER],
    labels: KIND_LABELS,
  };
  return `<title>Koala drift</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&family=Literata:opsz,wght@7..72,600&display=swap">
<style>
/* Layout: findings first (what needs the owner, then known work); below, a flow picker and one step at a time, agreed beside actual. */
:root {
  --bg: #f6f7f5; --surface: #ffffff; --fg: #1d2421; --muted: #5b6862; --line: #d9dfdb; --accent: #1f6f5c;
  --ask-bg: #fbeadb; --ask-fg: #9a4a12; --work-bg: #e8eef6; --work-fg: #2f5b8f;
  --mine-bg: #ebe9f5; --mine-fg: #4d4590; --code-bg: #edf0ee;
  --display: "Literata", Georgia, serif; --body: "IBM Plex Sans", system-ui, sans-serif; --mono: "IBM Plex Mono", ui-monospace, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --bg: #141917; --surface: #1b2220; --fg: #e3e9e6; --muted: #9aa8a1; --line: #2e3834; --accent: #6cc2a8; --ask-bg: #43291a; --ask-fg: #f2b585; --work-bg: #1d2a3a; --work-fg: #9cc0ea; --mine-bg: #2a2742; --mine-fg: #b9b2f0; --code-bg: #232c29; color-scheme: dark; }
}
:root[data-theme="dark"] { --bg: #141917; --surface: #1b2220; --fg: #e3e9e6; --muted: #9aa8a1; --line: #2e3834; --accent: #6cc2a8; --ask-bg: #43291a; --ask-fg: #f2b585; --work-bg: #1d2a3a; --work-fg: #9cc0ea; --mine-bg: #2a2742; --mine-fg: #b9b2f0; --code-bg: #232c29; color-scheme: dark; }
body { background: var(--bg); color: var(--fg); font: 15px/1.6 var(--body); }
.page { max-width: 1040px; margin: 0 auto; padding-block: 36px 80px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); display: flex; flex-direction: column; gap: 28px; }
h1, h2 { font-family: var(--display); font-weight: 600; margin: 0; text-wrap: balance; }
h1 { font-size: 2rem; } h2 { font-size: 1.25rem; } h3 { margin: 0; font-size: .78rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
p { margin: 0; max-width: 72ch; }
code { font-family: var(--mono); font-size: .82rem; background: var(--code-bg); padding: 1px 5px; border-radius: 4px; overflow-wrap: anywhere; }
.lede { color: var(--muted); display: flex; flex-direction: column; gap: 8px; }
.summary { display: flex; flex-wrap: wrap; gap: 10px; }
.count { border-radius: 8px; padding: 10px 14px; display: flex; flex-direction: column; min-width: 9rem; }
.count b { font-size: 1.6rem; font-variant-numeric: tabular-nums; line-height: 1.1; }
.count.ask { background: var(--ask-bg); color: var(--ask-fg); }
.count.work { background: var(--work-bg); color: var(--work-fg); }
.findings { display: flex; flex-direction: column; gap: 10px; }
.finding { background: var(--surface); border: 1px solid var(--line); border-left: 4px solid var(--ask-fg); border-radius: 8px; padding: 12px 16px; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.finding.work { border-left-color: var(--work-fg); }
.finding .kind { font: 500 .7rem/1 var(--body); text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.finding .title { font-weight: 600; }
.finding .steps { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { font: 500 .78rem/1 var(--mono); padding: 5px 8px; border-radius: 5px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); cursor: pointer; }
.chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
details summary { cursor: pointer; color: var(--muted); font-size: .88rem; }
pre { margin: 6px 0 0; background: var(--code-bg); border-radius: 6px; padding: 10px; overflow-x: auto; font: .78rem/1.5 var(--mono); }
.explorer { display: grid; grid-template-columns: minmax(0, 15rem) minmax(0, 1fr); gap: 20px; align-items: start; }
@media (max-width: 760px) { .explorer { grid-template-columns: minmax(0, 1fr); } }
nav.flows { display: flex; flex-direction: column; gap: 12px; }
nav.flows .flow { display: flex; flex-direction: column; gap: 6px; }
nav.flows .flow-name { font-size: .88rem; font-weight: 600; }
nav.flows .row { display: flex; flex-wrap: wrap; gap: 5px; }
.chip.has-ask { background: var(--ask-bg); color: var(--ask-fg); border-color: transparent; }
.chip.has-work { background: var(--work-bg); color: var(--work-fg); border-color: transparent; }
.chip.on { outline: 2px solid var(--accent); }
.step { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 18px 20px; display: flex; flex-direction: column; gap: 16px; min-width: 0; scroll-margin-top: 12px; }
.columns { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 18px; }
@media (max-width: 760px) { .columns { grid-template-columns: minmax(0, 1fr); } }
.column { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.decision { border-left: 3px solid var(--accent); padding-left: 10px; display: flex; flex-direction: column; gap: 4px; }
.decision q { color: var(--muted); font-size: .9rem; }
.mine { background: var(--mine-bg); border-radius: 6px; padding: 8px 12px; font-size: .9rem; }
.mine .label { display: block; font: 500 .68rem/1.4 var(--body); text-transform: uppercase; letter-spacing: .06em; color: var(--mine-fg); }
ul.plain { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.crossing { font: .8rem/1.5 var(--mono); overflow-wrap: anywhere; }
.crossing b { color: var(--accent); font-weight: 500; }
.empty { color: var(--muted); font-size: .9rem; }
.branch { font-size: .9rem; }
</style>
<div class="page">
<header class="lede">
  <h1>Koala drift</h1>
  <p>What we agreed beside what the code does, for every v1 step. The agreed side is the flows (<code>tests/alignment/v1-flows.ts</code>) and your decisions; the code side is traced through the repository from the screen the person is on. Built by <code>npm run drift</code> from <code id="commit"></code>.</p>
</header>
<section class="summary" id="summary" aria-label="Counts"></section>
<section class="findings" id="for-owner" aria-label="For you"></section>
<section class="findings" id="answered" aria-label="Asked or noted"></section>
<section class="findings" id="work" aria-label="Known work"></section>
<section aria-label="Flows" class="explorer">
  <nav class="flows" id="flows"></nav>
  <article class="step" id="step"></article>
</section>
</div>
<script>
const DATA = ${json(data)};
const el = (tag, attrs, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) key === 'class' ? (node.className = value) : node.setAttribute(key, value);
  for (const child of children.flat()) if (child !== null && child !== undefined) node.append(child.nodeType ? child : document.createTextNode(String(child)));
  return node;
};
const steps = DATA.flows.flatMap((flow) => flow.steps.map((step) => ({ ...step, flow })));
const forOwner = new Set(DATA.forOwner);
const findingsOn = (id) => DATA.findings.filter((finding) => finding.steps.includes(id));
const stepChip = (id) => { const chip = el('button', { class: 'chip', type: 'button' }, id); chip.addEventListener('click', () => show(id, true)); return chip; };

document.getElementById('commit').textContent = DATA.commit;
const asks = DATA.findings.filter((finding) => forOwner.has(finding.kind) && !DATA.answers[finding.id]);
const answered = DATA.findings.filter((finding) => forOwner.has(finding.kind) && DATA.answers[finding.id]);
const work = DATA.findings.filter((finding) => !forOwner.has(finding.kind));
document.getElementById('summary').append(
  el('div', { class: 'count ask' }, el('b', {}, asks.length), 'need you'),
  el('div', { class: 'count' }, el('b', {}, answered.length), 'asked or noted'),
  el('div', { class: 'count work' }, el('b', {}, work.length), 'decided, not done'),
);

const findingCard = (finding) => el('div', { class: 'finding' + (forOwner.has(finding.kind) ? '' : ' work') },
  el('span', { class: 'kind' }, DATA.labels[finding.kind]),
  el('span', { class: 'title' }, finding.title),
  el('p', {}, finding.detail),
  finding.steps.length ? el('div', { class: 'steps' }, finding.steps.map(stepChip)) : null,
  finding.where.length ? el('details', {}, el('summary', {}, finding.where.length + (finding.where.length === 1 ? ' place' : ' places')), el('pre', {}, finding.where.join('\\n'))) : null,
  DATA.answers[finding.id] ? el('div', { class: 'mine' }, el('span', { class: 'label' }, DATA.answers[finding.id].state + ' ' + DATA.answers[finding.id].at.replace('T', ' ')), DATA.answers[finding.id].why) : null,
);
document.getElementById('for-owner').append(el('h2', {}, 'For you'), asks.length ? asks.map(findingCard) : el('p', { class: 'empty' }, 'Nothing waits on you.'));
document.getElementById('answered').append(el('h2', {}, 'Asked or noted'), answered.length ? answered.map(findingCard) : el('p', { class: 'empty' }, 'None.'));
document.getElementById('work').append(el('h2', {}, 'Decided, not done yet'), ...work.map(findingCard));

const nav = document.getElementById('flows');
for (const flow of DATA.flows) {
  const row = el('div', { class: 'row' }, flow.steps.map((step) => {
    const chip = stepChip(step.id);
    chip.dataset.step = step.id;
    const on = findingsOn(step.id);
    if (on.some((finding) => forOwner.has(finding.kind) && !DATA.answers[finding.id])) chip.classList.add('has-ask');
    else if (on.length) chip.classList.add('has-work');
    return chip;
  }));
  nav.append(el('div', { class: 'flow' }, el('span', { class: 'flow-name' }, flow.id + '. ' + flow.title), row));
}

function show(id, scroll) {
  const step = steps.find((entry) => entry.id === id) || steps[0];
  for (const chip of nav.querySelectorAll('.chip')) chip.classList.toggle('on', chip.dataset.step === step.id);
  try { history.replaceState(null, '', '#' + step.id); } catch (failure) {}
  const trace = DATA.traces[step.id];
  const agreed = el('div', { class: 'column' },
    el('h3', {}, 'Agreed'),
    el('p', {}, step.does),
    el('p', { class: 'empty' }, 'On ' + step.screen.on + (step.screen.route ? ' at ' + step.screen.route : '') + (step.screen.component ? ', ' + step.screen.component.split('/').pop() : '')),
    step.decisions.length ? step.decisions.map((key) => {
      const decision = DATA.decisions[key];
      const last = decision.words[decision.words.length - 1];
      return el('div', { class: 'decision' }, el('b', {}, decision.subject), el('q', {}, last.text), el('div', { class: 'mine' }, el('span', { class: 'label' }, 'My reading'), decision.reading));
    }) : el('p', { class: 'empty' }, 'No decision of yours behind it.'),
    step.branches ? el('ul', { class: 'plain' }, step.branches.map((branch) => el('li', { class: 'branch' }, el('b', {}, branch.when + ': '), branch.outcome))) : null,
    step.assumed ? el('div', { class: 'mine' }, el('span', { class: 'label' }, 'My assumption'), step.assumed) : null,
  );
  const crossings = trace.crossings.length
    ? el('ul', { class: 'plain' }, trace.crossings.map((crossing) => el('li', { class: 'crossing' }, el('b', {}, crossing.through), ' ' + crossing.from + ' → ' + crossing.to)))
    : el('p', { class: 'empty' }, 'Crosses into no other process.');
  const concepts = Object.entries(trace.concepts);
  const actual = el('div', { class: 'column' },
    el('h3', {}, 'In the code'),
    trace.starts.length ? el('p', { class: 'crossing' }, 'Starts at ' + trace.starts.join(', ')) : el('p', { class: 'empty' }, 'No code is named for this step.'),
    trace.notFound.length ? el('p', { class: 'empty' }, 'The map does not hold: ' + trace.notFound.join(', ')) : null,
    crossings,
    concepts.length ? el('p', { class: 'empty' }, concepts.map(([concept, count]) => concept + ' ' + count).join(' · ')) : null,
    trace.files.length ? el('details', {}, el('summary', {}, trace.files.length + ' files in ' + trace.areas.length + ' areas'), el('pre', {}, trace.files.join('\\n'))) : null,
  );
  const here = findingsOn(step.id);
  const box = document.getElementById('step');
  box.replaceChildren(
    el('h2', {}, step.id + '. ' + step.flow.title),
    el('div', { class: 'columns' }, agreed, actual),
    here.length ? el('div', { class: 'findings' }, el('h3', {}, 'Findings on this step'), here.map(findingCard)) : el('p', { class: 'empty' }, 'No findings on this step.'),
  );
  if (scroll) box.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}
show(location.hash.slice(1), false);
addEventListener('hashchange', () => show(location.hash.slice(1), false));
</script>
`;
}
