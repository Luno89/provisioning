import type { Decision, Words } from './decisions.js';

const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const when = (at: string): string => at.slice(0, 16).replace('T', ' ');

const quote = (words: Words): string => `<li><span class="at">${when(words.at)}</span>${words.asked ? `<span class="asked">Asked: ${escape(words.asked)}</span>` : ''}<q>${escape(words.text)}</q></li>`;

const card = (decision: Decision): string => `
<article id="${escape(decision.id)}">
  <header><h2>${escape(decision.subject)}</h2><code>${escape(decision.id)}</code></header>
  <ol class="words">${decision.words.map(quote).join('')}</ol>
  ${decision.replaced?.length ? `<div class="replaced"><h3>Replaced</h3><ol class="words">${decision.replaced.map((entry) => `${quote(entry.words)}<li class="by">${escape(entry.by)}</li>`).join('')}</ol></div>` : ''}
  <div class="reading"><span class="label">My reading</span><p>${escape(decision.reading)}</p></div>
  ${decision.steps.length ? `<p class="steps">Flow steps: ${decision.steps.map(escape).join(', ')}</p>` : ''}
</article>`;

export function registerPage(decisions: readonly Decision[], commit: string): string {
  const quotes = decisions.reduce((count, decision) => count + decision.words.length, 0);
  return `<title>Koala decision register</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&family=Literata:opsz,wght@7..72,600&display=swap">
<style>
/* Layout: one column of decision cards; the owner's words first, my reading beneath, marked as mine. */
:root {
  --bg: #f6f7f5; --surface: #ffffff; --fg: #1d2421; --muted: #5b6862; --line: #d9dfdb; --accent: #1f6f5c;
  --reading-bg: #ebe9f5; --reading-fg: #4d4590; --code-bg: #edf0ee;
  --display: "Literata", Georgia, serif; --body: "IBM Plex Sans", system-ui, sans-serif; --mono: "IBM Plex Mono", ui-monospace, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --bg: #141917; --surface: #1b2220; --fg: #e3e9e6; --muted: #9aa8a1; --line: #2e3834; --accent: #6cc2a8; --reading-bg: #2a2742; --reading-fg: #b9b2f0; --code-bg: #232c29; color-scheme: dark; }
}
:root[data-theme="dark"] { --bg: #141917; --surface: #1b2220; --fg: #e3e9e6; --muted: #9aa8a1; --line: #2e3834; --accent: #6cc2a8; --reading-bg: #2a2742; --reading-fg: #b9b2f0; --code-bg: #232c29; color-scheme: dark; }
body { background: var(--bg); color: var(--fg); font: 15px/1.6 var(--body); }
.page { max-width: 820px; margin: 0 auto; padding-block: 40px 80px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); display: flex; flex-direction: column; gap: 24px; }
h1, h2 { font-family: var(--display); font-weight: 600; text-wrap: balance; margin: 0; }
h1 { font-size: 2rem; } h2 { font-size: 1.15rem; } h3 { font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0; }
p { margin: 0; max-width: 70ch; }
code { font-family: var(--mono); font-size: .8rem; color: var(--muted); background: var(--code-bg); padding: 1px 6px; border-radius: 4px; }
.lede { color: var(--muted); display: flex; flex-direction: column; gap: 8px; }
nav { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: .88rem; }
nav a { color: var(--accent); }
article { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 18px 20px; display: flex; flex-direction: column; gap: 12px; scroll-margin-top: 16px; }
article header { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: baseline; justify-content: space-between; }
ol.words { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
ol.words li { display: flex; flex-direction: column; gap: 2px; padding-left: 12px; border-left: 3px solid var(--accent); }
.at { font: 500 .78rem/1.4 var(--mono); color: var(--muted); font-variant-numeric: tabular-nums; }
.asked { font-size: .85rem; color: var(--muted); }
q { quotes: "\\201C" "\\201D"; }
.by { border-left-color: var(--line) !important; color: var(--muted); font-size: .88rem; }
.replaced { display: flex; flex-direction: column; gap: 8px; opacity: .85; }
.reading { background: var(--reading-bg); border-radius: 6px; padding: 10px 14px; display: flex; flex-direction: column; gap: 4px; }
.reading .label { font: 500 .7rem/1 var(--body); letter-spacing: .06em; text-transform: uppercase; color: var(--reading-fg); }
.steps { font-size: .85rem; color: var(--muted); }
</style>
<div class="page">
<header class="lede">
  <h1>Koala decision register</h1>
  <p>Every decision once, in your words, with when you said them. Each quote is checked word for word against the session transcripts (<code>npm run decisions</code>). Beneath each, marked, is my reading of it. The readings are what I'll work from, so they're what to check. Tell me by id where a reading is wrong; a decision changes only by your words.</p>
  <p>${decisions.length} decisions, ${quotes} quotes, from <code>${escape(commit)}</code>.</p>
  <nav>${decisions.map((decision) => `<a href="#${escape(decision.id)}">${escape(decision.subject)}</a>`).join('')}</nav>
</header>
${decisions.map(card).join('\n')}
</div>
`;
}
