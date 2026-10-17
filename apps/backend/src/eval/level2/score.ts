import type { ToolDefinition } from '@koala/agent-engine';
import type { Task } from '../../engine-host/tools/tasks.js';
import { formatProcedureProblems, readAndCheckProcedure } from '@koala/agent-engine/procedure';
import type { ExpectedBrowserTests, ProvokedFailure, ScenarioExpectations } from './scenario.js';
import { platformCatalogue, platformGroups } from '../../extensions/installed.js';
import { describeChoice, scoreTurn, type TurnReply } from '../../lib/turn-check.js';

export interface ToolCallLog {
  runId: string;
  name: string;
  arguments: string;
  ok: boolean;
  digest: string;
}

export interface StoredProcedure {
  id: string;
  source: string;
}

export interface ObservedHandOff {
  agent: string;
  startedAt: number;
  finishedAt: number;
  outcome: string;
}

export interface ObservedFlow {
  plan?: { type?: string | undefined; version?: string | undefined; release?: string | undefined; startsFrom?: string | undefined } | undefined;
  clientImport?: string | undefined;
  build?: { status: string; held?: string | undefined } | undefined;
  notices?: string[] | undefined;
  modelRequests?: string[] | undefined;
  compacted?: boolean | undefined;
  summary?: { through: number } | undefined;
  kept?: { interrupted: boolean; chars: number; loggedChars: number; prefix: boolean } | undefined;
  turnLog?: { contiguous: boolean; savedMatches: boolean; entries: number } | undefined;
  leaves?: { title: string; status: string; verified: boolean; landed?: string | undefined; findings?: string | undefined; retried?: number | undefined; artifacts?: { name: string; opens: boolean; contentType?: string | undefined; size?: number | undefined }[] | undefined }[] | undefined;
  mergeTasks?: number | undefined;
  repository?: Record<string, string | null> | undefined;
  pullRequests?: { merged: number; open: number; closedUnmerged: number } | undefined;
  workspaceExists?: boolean | undefined;
  projectExists?: boolean | undefined;
  mcpServer?: { exists: boolean; state?: string | undefined; why?: string | undefined; heldBy: string[] } | undefined;
  releasedBy?: { agent?: string | undefined; app?: string | undefined; from?: string | undefined } | undefined;
  treeModels?: { agent: string; chosen?: string | undefined }[] | undefined;
  trees?: number | undefined;
  step?: { exit?: string | undefined; outputs?: Record<string, unknown> | undefined; error?: string | undefined } | undefined;
  turn?: TurnReply | undefined;
  release?: ObservedRelease | undefined;
  e2e?: ObservedBrowserTests | undefined;
}

export interface ObservedBrowserTests {
  state: string;
  summary?: string | undefined;
  reason?: string | undefined;
  tests?: { title: string; status: string; error?: string | undefined }[] | undefined;
  artifacts?: { name: string; opens: boolean; contentType?: string | undefined; size?: number | undefined }[] | undefined;
}

export interface ObservedRelease {
  exists: boolean;
  state?: string | undefined;
  slot?: string | undefined;
  reason?: string | undefined;
  e2e?: ObservedBrowserTests | undefined;
}

export interface Observed {
  flow?: ObservedFlow | undefined;
  handOffs?: ObservedHandOff[] | undefined;
  files?: Record<string, string | null> | undefined;
  outcome: string;
  reason?: string | undefined;
  calls: ToolCallLog[];
  tasks: Task[];
  counters: { rounds: number; toolCalls: number; totalTokens: number };
  answer: string;
  saved: StoredProcedure[];
}

export interface Check {
  what: string;
  passed: boolean;
  detail: string;
}

export const failureMatcher = (says: string): RegExp =>
  new RegExp(says.split(/<[^>]+>/).map((part) => part.trim()).filter(Boolean).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*'), 'i');

export function failedCalls(calls: readonly ToolCallLog[], provoked: ProvokedFailure, tools: readonly ToolDefinition[]): ToolCallLog[] {
  const says = tools.find((tool) => tool.name === provoked.tool)?.failures.find((failure) => failure.when === provoked.when)?.says;
  const matches = says ? failureMatcher(says) : undefined;
  return calls.filter((call) => call.name === provoked.tool && !call.ok && (!matches || matches.test(call.digest)));
}

const list = (names: readonly string[]): string => names.join(', ') || 'nothing';

export interface ScoreOptions {
  tools: readonly ToolDefinition[];
  reported?: ((says: string, answer: string) => Promise<boolean>) | undefined;
  says?: ((means: string, answer: string, index: number) => Promise<boolean>) | undefined;
}

export async function scoreScenario(expect: ScenarioExpectations, observed: Observed, options: ScoreOptions): Promise<Check[]> {
  const checks: Check[] = [];
  const called = observed.calls.map((call) => call.name);
  const add = (what: string, passed: boolean, detail: string) => checks.push({ what, passed, detail });

  if (expect.outcome !== undefined) {
    add(`finishes ${expect.outcome}`, observed.outcome === expect.outcome,
      observed.outcome === expect.outcome ? `it finished ${observed.outcome}` : `it finished ${observed.outcome}${observed.reason ? `: ${observed.reason}` : ''}`);
  }

  for (const name of expect.toolsCalled ?? []) {
    add(`calls ${name}`, called.includes(name), called.includes(name) ? `it called ${name}` : `it called ${list([...new Set(called)])}`);
  }

  for (const name of expect.toolsSucceeded ?? []) {
    const tries = observed.calls.filter((call) => call.name === name);
    const worked = tries.some((call) => call.ok);
    add(`calls ${name} and it works`, worked,
      worked ? `${name} worked${tries.length > 1 ? ` on the ${tries.findIndex((call) => call.ok) + 1}${['st', 'nd', 'rd'][tries.findIndex((call) => call.ok)] ?? 'th'} try` : ''}`
        : tries.length === 0 ? `it never called ${name}` : `${tries.length} call${tries.length === 1 ? '' : 's'} to ${name}, none worked; the last said: ${tries.at(-1)!.digest.slice(0, 160)}`);
  }

  for (const name of expect.toolsNotCalled ?? []) {
    add(`never calls ${name}`, !called.includes(name), called.includes(name) ? `it called ${name}` : `it did not call ${name}`);
  }

  if (expect.toolsInOrder?.length) {
    let at = 0;
    for (const name of called) if (at < expect.toolsInOrder.length && name === expect.toolsInOrder[at]) at += 1;
    add(`calls ${expect.toolsInOrder.join(' then ')}`, at === expect.toolsInOrder.length,
      at === expect.toolsInOrder.length ? 'it called them in that order' : `it got as far as ${at === 0 ? 'none of them' : expect.toolsInOrder.slice(0, at).join(' then ')}, calling ${list(called)}`);
  }

  for (const wanted of expect.tasks ?? []) {
    const task = observed.tasks.find((candidate) => candidate.id === wanted.id);
    add(`leaves ${wanted.id} ${wanted.status}`, task?.status === wanted.status,
      task ? `it is ${task.status}${task.evidence ? `: ${task.evidence.slice(0, 120)}` : ''}` : `there is no task called ${wanted.id}`);
  }

  for (const [measure, ceiling] of Object.entries(expect.within ?? {})) {
    if (ceiling === undefined) continue;
    const spent = observed.counters[measure as keyof Observed['counters']];
    add(`within ${ceiling} ${measure}`, spent <= ceiling, `it used ${spent}`);
  }

  if (expect.saved) {
    const found = observed.saved.find((entry) => entry.id === expect.saved!.procedure);
    if (!expect.saved.stored) {
      add(`saves no procedure called ${expect.saved.procedure}`, !found,
        found ? `it saved ${expect.saved.procedure}` : `nothing called ${expect.saved.procedure} was saved`);
    } else if (!found) {
      add(`saves ${expect.saved.procedure}`, false,
        observed.saved.length > 0 ? `it saved ${list(observed.saved.map((entry) => entry.id))}` : 'it saved nothing');
    } else {
      const checked = readAndCheckProcedure(found.source, { catalogue: platformCatalogue(), groups: platformGroups() });
      add(`saves ${expect.saved.procedure}, and what is stored checks clean`, checked.ok,
        checked.ok ? `${found.id} is stored and checks clean` : `${found.id} is stored but does not check clean:\n${formatProcedureProblems(checked.problems)}`);
    }
  }

  for (const wanted of expect.handOffs ?? []) {
    const made = (observed.handOffs ?? []).filter((handOff) => handOff.agent === wanted.agent);
    const count = `${made.length} hand-off${made.length === 1 ? '' : 's'} to ${wanted.agent}`;
    const atLeast = wanted.atLeast ?? (wanted.atMost === undefined && !wanted.together ? 1 : undefined);
    if (atLeast !== undefined) add(atLeast === 1 && wanted.atLeast === undefined ? `hands work to ${wanted.agent}` : `hands work to ${wanted.agent} at least ${atLeast} times`, made.length >= atLeast, `it made ${count}`);
    if (wanted.atMost !== undefined) add(`hands work to ${wanted.agent} at most ${wanted.atMost} times`, made.length <= wanted.atMost, `it made ${count}`);
    if (wanted.together) {
      const overlapping = made.filter((handOff) => made.some((other) => other !== handOff && other.startedAt < handOff.finishedAt && handOff.startedAt < other.finishedAt));
      add(`hands work to ${wanted.agent} several at once`, made.length >= 2 && overlapping.length === made.length,
        made.length < 2 ? `it made ${count}` : `${overlapping.length} of its ${made.length} hand-offs to ${wanted.agent} ran at the same time as another`);
    }
  }

  for (const wanted of expect.files ?? []) {
    const content = observed.files?.[wanted.path];
    if (content === null || content === undefined) {
      add(`writes ${wanted.path}`, false, `there is no ${wanted.path} in its workspace`);
      continue;
    }
    const missing = (wanted.contains ?? []).filter((text) => !content.toLowerCase().includes(text.toLowerCase()));
    add(`writes ${wanted.path}${wanted.contains?.length ? ` saying ${wanted.contains.join(', ')}` : ''}`, missing.length === 0,
      missing.length === 0 ? `${wanted.path} is there (${content.length} characters)` : `${wanted.path} does not mention ${missing.join(', ')}: "${content.slice(0, 160)}"`);
  }

  const provoked = expect.provokes;
  if (provoked) {
    const failures = failedCalls(observed.calls, provoked, options.tools);
    add(`${provoked.tool} fails when ${provoked.when}`, failures.length > 0,
      failures.length > 0 ? `${provoked.tool} failed: ${failures[0]!.digest.slice(0, 120)}` : `${provoked.tool} never failed that way`);

    if (failures.length > 0) {
      const after = observed.calls.slice(observed.calls.indexOf(failures.at(-1)!) + 1);
      if (provoked.then === 'retried') {
        const retried = after.find((call) => call.name === provoked.tool && call.ok);
        add('it tries again with what the failure told it', Boolean(retried), retried ? `it called ${provoked.tool} again and that worked` : `it never called ${provoked.tool} successfully afterwards`);
      } else {
        const says = options.tools.find((tool) => tool.name === provoked.tool)?.failures.find((failure) => failure.when === provoked.when)?.says ?? provoked.when;
        const told = observed.answer.trim() ? await (options.reported?.(says, observed.answer) ?? Promise.resolve(false)) : false;
        add('it tells the person what went wrong', told, told ? 'its answer says what failed' : `its answer does not say what failed: "${observed.answer.slice(0, 120)}"`);
      }
    }
  }

  const flow = observed.flow ?? {};
  if (expect.modelSaw) {
    const requests = flow.modelRequests ?? [];
    const seen = `the model was sent ${requests.length} request${requests.length === 1 ? '' : 's'}`;
    if (expect.modelSaw.anyRequest) {
      const carrying = (text: string) => requests.filter((request) => request.includes(text)).length;
      for (const text of expect.modelSaw.contains ?? []) add(`some request to the model carries "${text}"`, carrying(text) > 0, `${seen}; ${carrying(text)} carried it`);
      for (const text of expect.modelSaw.lacks ?? []) add(`no request to the model carries "${text}"`, carrying(text) === 0, `${seen}; ${carrying(text)} carried it`);
    } else {
      const last = requests.at(-1) ?? '';
      for (const text of expect.modelSaw.contains ?? []) add(`the model is sent "${text}"`, last.includes(text), last.includes(text) ? `${seen}; the last one had it` : `${seen}; the last one did not have it`);
      for (const text of expect.modelSaw.lacks ?? []) add(`the model is no longer sent "${text}"`, !last.includes(text), last.includes(text) ? `${seen}; the last one still had it` : `${seen}; the last one did not have it`);
    }
  }
  if (expect.compacted !== undefined) {
    add(expect.compacted ? 'summarises the conversation' : 'does not summarise again', flow.compacted === expect.compacted, flow.compacted ? 'the conversation was summarised in this turn' : 'nothing was summarised in this turn');
  }
  if (expect.summaryKept !== undefined) {
    const kept = Boolean(flow.summary);
    add(expect.summaryKept ? 'the conversation keeps a summary' : 'the conversation keeps no summary', kept === expect.summaryKept,
      flow.summary ? `it keeps a summary of its first ${flow.summary.through} messages` : 'it keeps no summary');
  }
  if (expect.interrupted !== undefined) {
    const kept = flow.kept;
    const good = Boolean(kept && kept.interrupted === expect.interrupted && (!expect.interrupted || (kept.chars > 0 && kept.prefix)));
    add(expect.interrupted ? 'keeps what the dead turn had said, marked interrupted' : 'saves the turn as finished', good,
      !kept ? 'the conversation kept no reply for this turn'
        : `it kept ${kept.chars} characters${kept.interrupted ? ', marked interrupted' : ''}; the turn log held ${kept.loggedChars}${kept.prefix ? '' : ', and the kept reply is not what the log held'}`);
  }
  if (expect.turnLog?.complete) {
    const log = flow.turnLog;
    add('the turn log holds the whole turn', Boolean(log?.contiguous && log.savedMatches),
      !log ? 'there is no turn log' : !log.contiguous ? `the turn log's ${log.entries} entries have a gap` : !log.savedMatches ? 'the saved reply is not what the turn log streamed' : `${log.entries} entries, no gap, and the saved reply is what they streamed`);
  }
  if (expect.leaves) {
    const leaves = flow.leaves ?? [];
    if (expect.leaves.verified !== undefined) {
      const verified = leaves.filter((leaf) => leaf.verified).length;
      add(`${expect.leaves.verified} leaves are verified`, verified === expect.leaves.verified, `${verified} of ${leaves.length} are: ${leaves.map((leaf) => `${leaf.title} ${leaf.status}${leaf.verified ? ', verified' : ''}`).join('; ')}`);
    }
    for (const [title, outcome] of Object.entries(expect.leaves.landed ?? {})) {
      const leaf = leaves.find((entry) => entry.title === title);
      add(`${title} lands as ${outcome}`, leaf?.landed === outcome, leaf ? (leaf.landed ? `it landed as ${leaf.landed}` : `it has not landed (${leaf.status})`) : `there is no leaf called ${title}`);
    }
    for (const [title, wanted] of Object.entries(expect.leaves.findings ?? {})) {
      const leaf = leaves.find((entry) => entry.title === title);
      const missing = wanted.filter((text) => !(leaf?.findings ?? '').includes(text));
      add(`${title}'s findings say ${wanted.map((text) => `"${text}"`).join(', ')}`, Boolean(leaf) && missing.length === 0, !leaf ? `there is no leaf called ${title}` : missing.length > 0 ? `they do not say ${missing.map((text) => `"${text}"`).join(', ')}: ${(leaf.findings ?? 'none').slice(0, 300)}` : 'they do');
    }
    for (const [title, least] of Object.entries(expect.leaves.artifacts ?? {})) {
      const leaf = leaves.find((entry) => entry.title === title);
      const opening = (leaf?.artifacts ?? []).filter((artifact) => artifact.opens);
      add(`${title} leaves at least ${least} browser files that open`, opening.length >= least, !leaf ? `there is no leaf called ${title}` : `${opening.length} of ${(leaf.artifacts ?? []).length} open${(leaf.artifacts ?? []).length > 0 ? `: ${(leaf.artifacts ?? []).map((artifact) => `${artifact.name} ${artifact.opens ? `(${artifact.contentType}, ${artifact.size} bytes)` : 'does not open'}`).join('; ')}` : ''}`);
    }
    for (const [title, times] of Object.entries(expect.leaves.retried ?? {})) {
      const leaf = leaves.find((entry) => entry.title === title);
      add(`${title} was retried ${times} time${times === 1 ? '' : 's'}`, leaf?.retried === times, !leaf ? `there is no leaf called ${title}` : `it was retried ${leaf.retried ?? 0}`);
    }
    if (expect.leaves.mergeTasks !== undefined) add(`${expect.leaves.mergeTasks} merge tasks`, flow.mergeTasks === expect.leaves.mergeTasks, `there ${flow.mergeTasks === 1 ? 'is' : 'are'} ${flow.mergeTasks ?? 0}`);
  }
  if (expect.repository) {
    for (const file of expect.repository.files) {
      const content = flow.repository?.[file.path];
      if (content === null || content === undefined) {
        add(`the ${expect.repository.of}'s main holds ${file.path}`, false, `${file.path} is not on main`);
        continue;
      }
      const missing = (file.contains ?? []).filter((text) => !content.includes(text));
      add(`the ${expect.repository.of}'s main holds ${file.path}${file.contains?.length ? ` saying ${file.contains.join(', ')}` : ''}`, missing.length === 0,
        missing.length === 0 ? `${file.path} is on main` : `${file.path} on main does not say ${missing.join(', ')}: "${content.slice(0, 160)}"`);
      const present = (file.lacks ?? []).filter((text) => content.includes(text));
      if (file.lacks?.length) add(`${file.path} on the ${expect.repository.of}'s main does not say ${file.lacks.join(', ')}`, present.length === 0, present.length === 0 ? 'it does not' : `it says ${present.join(', ')}`);
    }
  }
  if (expect.pullRequests) {
    const pulls = flow.pullRequests ?? { merged: 0, open: 0, closedUnmerged: 0 };
    const said = `${pulls.merged} merged, ${pulls.open} open, ${pulls.closedUnmerged} closed unmerged`;
    if (expect.pullRequests.merged !== undefined) add(`${expect.pullRequests.merged} pull requests merged`, pulls.merged === expect.pullRequests.merged, said);
    if (expect.pullRequests.open !== undefined) add(`${expect.pullRequests.open} pull requests open`, pulls.open === expect.pullRequests.open, said);
    if (expect.pullRequests.closedUnmerged !== undefined) add(`${expect.pullRequests.closedUnmerged} pull requests closed unmerged`, pulls.closedUnmerged === expect.pullRequests.closedUnmerged, said);
  }
  if (expect.workspace) {
    add(`the ${expect.workspace.of}'s workspace ${expect.workspace.exists ? 'is there' : 'is gone'}`, flow.workspaceExists === expect.workspace.exists, flow.workspaceExists ? 'it is there' : 'it is gone');
  }

  if (expect.said) {
    const answer = observed.answer;
    const quoted = `it said: "${answer.slice(0, 200)}${answer.length > 200 ? '…' : ''}"`;
    for (const words of expect.said.contains ?? []) add(`it says "${words}"`, answer.toLowerCase().includes(words.toLowerCase()), quoted);
    for (const [index, means] of (expect.said.means ?? []).entries()) {
      const yes = answer.trim() ? await (options.says?.(means, answer, index) ?? Promise.resolve(false)) : false;
      add(`its answer ${means}`, yes, quoted);
    }
  }
  if (expect.plan) {
    const plan = flow.plan;
    if (!plan) add('it proposes a plan for a new tree', false, 'no plan for a new tree was proposed in the conversation');
    else {
      if (expect.plan.type !== undefined) add(`the plan's tree is a ${expect.plan.type} tree`, plan.type === expect.plan.type, `it is ${plan.type ?? 'of no type'}`);
      if (expect.plan.version !== undefined) add(`the plan's tree is version ${expect.plan.version}`, plan.version === expect.plan.version, `it is ${plan.version ?? 'the default version'}`);
      if (expect.plan.release !== undefined) add(expect.plan.release === null ? 'the plan leaves releasing to its type' : `the plan releases it by ${expect.plan.release}`, (plan.release ?? null) === expect.plan.release, plan.release ? `it releases by ${plan.release}` : 'it leaves releasing to its type');
      if (expect.plan.startsFrom !== undefined) add(expect.plan.startsFrom === null ? 'the plan starts from its starter' : 'the plan starts from the client\'s database', (plan.startsFrom ?? null) === expect.plan.startsFrom, plan.startsFrom ? `it starts from ${plan.startsFrom}` : 'it starts from the starter');
    }
  }
  if (expect.clientImport) {
    const state = flow.clientImport ?? null;
    add(expect.clientImport.state === null ? 'the project waits for no client\'s database' : `the client's database is ${expect.clientImport.state}`, state === expect.clientImport.state, state ? `it is ${state}` : 'there is none');
  }
  if (expect.build?.held !== undefined) {
    const held = Boolean(flow.build?.held);
    add(expect.build.held ? 'its build is held' : 'its build is not held', held === expect.build.held, flow.build ? (flow.build.held ? `held: ${flow.build.held}` : `it is ${flow.build.status}, not held`) : 'there is no build');
  }
  for (const words of expect.noticed ?? []) {
    const notices = flow.notices ?? [];
    add(`the channel is told "${words}"`, notices.some((notice) => notice.includes(words)), notices.length ? `it was told: ${notices.map((notice) => `"${notice.slice(0, 120)}"`).join('; ')}` : 'it was told nothing');
  }

  if (expect.exit !== undefined) {
    const step = flow.step;
    add(`the step leaves by ${expect.exit}`, step?.exit === expect.exit, !step ? 'the step never ran' : step.error ? `it failed: ${step.error}` : `it left by ${step.exit ?? 'no exit'}`);
  }
  for (const [socket, wanted] of Object.entries(expect.outputs ?? {})) {
    const produced = flow.step?.outputs?.[socket];
    const shown = produced === undefined ? 'nothing' : JSON.stringify(produced);
    if ('equals' in wanted) add(`the step's ${socket} is ${JSON.stringify(wanted.equals)}`, JSON.stringify(produced) === JSON.stringify(wanted.equals), `it is ${shown.slice(0, 200)}`);
    if (wanted.contains !== undefined) add(`the step's ${socket} has "${wanted.contains}"`, shown.includes(wanted.contains), `it is ${shown.slice(0, 200)}`);
  }
  if (expect.project) {
    add(expect.project.exists ? 'the project is there' : 'the project is gone', flow.projectExists === expect.project.exists, flow.projectExists ? 'it is there' : 'it is gone');
  }
  if (expect.chooses) {
    const verdict = flow.turn
      ? scoreTurn(flow.turn, expect.chooses, expect.chooses.tool === null ? undefined : options.tools.find((tool) => tool.name === expect.chooses!.tool))
      : { passed: false, complaint: 'the model was never asked' };
    const chose = flow.turn?.toolCalls.map((call) => call.name).join(', ');
    add(describeChoice(expect.chooses), verdict.passed, verdict.complaint ?? (chose ? `it called ${chose}` : 'it answered without calling a tool'));
  }
  if (expect.release) {
    const release = flow.release;
    if (expect.release.exists !== undefined) {
      add(expect.release.exists ? 'the project\'s app is there' : 'the project\'s app and its namespace are gone', release?.exists === expect.release.exists, release?.exists ? 'it is there' : 'it is gone');
    }
    if (expect.release.state !== undefined) {
      add(`the newest release is ${expect.release.state}`, release?.state === expect.release.state, !release?.state ? 'there is no release' : `it is ${release.state}${release.slot ? ` in slot ${release.slot}` : ''}${release.reason ? `: ${release.reason}` : ''}`);
    }
    if (expect.release.e2e) scoreBrowserTests(expect.release.e2e, release?.e2e, 'the preview\'s browser tests', add);
  }
  if (expect.e2e) scoreBrowserTests(expect.e2e, flow.e2e, 'the browser tests', add);
  if (expect.mcpServer) {
    const wanted = expect.mcpServer;
    const seen = flow.mcpServer;
    add(`the MCP server ${wanted.name} is there`, seen?.exists === true, seen?.exists ? 'it is' : 'there is no such server');
    if (wanted.state) add(`${wanted.name} is ${wanted.state}`, seen?.state === wanted.state, !seen?.state ? 'it has no state' : `it is ${seen.state}${seen.why ? `: ${seen.why}` : ''}`);
    if (wanted.heldBy) {
      const missing = wanted.heldBy.filter((slug) => !(seen?.heldBy ?? []).includes(slug));
      add(`${wanted.name} is held by ${wanted.heldBy.join(', ')}`, missing.length === 0, `held by ${(seen?.heldBy ?? []).join(', ') || 'no agent'}`);
    }
  }
  if (expect.releasedBy) {
    const wanted = expect.releasedBy;
    const seen = flow.releasedBy;
    const said = (how: { agent?: string | undefined; app?: string | undefined } | undefined) => (how?.agent ? `${how.agent}${how.app ? ` with ${how.app}` : ''}` : 'nothing');
    add(`${wanted.project ? 'the project\'s' : `the ${wanted.treeType} tree type's`} builds are released by ${said(wanted)}`, seen?.agent === wanted.agent && (seen?.app ?? undefined) === (wanted.app ?? undefined), `they are released by ${said(seen)}${seen?.from ? `, from its ${seen.from}` : ''}`);
  }
  if (expect.treeModels) {
    const seen = flow.treeModels ?? [];
    const said = (slug: string): string => {
      const row = seen.find((entry) => entry.agent === slug);
      return !row ? `${slug} is not in the tree's work` : row.chosen ? `it works on ${row.chosen}, chosen for the tree` : 'it works on its own model';
    };
    for (const slug of expect.treeModels.chosen ?? []) add(`the tree chose a model for ${slug}`, Boolean(seen.find((entry) => entry.agent === slug)?.chosen), said(slug));
    for (const slug of expect.treeModels.own ?? []) {
      const row = seen.find((entry) => entry.agent === slug);
      add(`${slug} works on its own model in the tree`, Boolean(row) && !row?.chosen, said(slug));
    }
  }
  if (expect.trees !== undefined) add(`${expect.trees} trees`, flow.trees === expect.trees, `there ${flow.trees === 1 ? 'is' : 'are'} ${flow.trees ?? 0}`);

  return checks;
}

function scoreBrowserTests(expect: ExpectedBrowserTests, seen: ObservedBrowserTests | undefined, what: string, add: (what: string, passed: boolean, detail: string) => void): void {
  const said = !seen ? 'they never ran' : `they ended ${seen.state}${seen.summary ? `: ${seen.summary}` : ''}${seen.reason ? ` — ${seen.reason.slice(0, 600)}` : ''}`;
  if (expect.state !== undefined) add(`${what} end ${expect.state}`, seen?.state === expect.state, said);
  for (const [title, status] of Object.entries(expect.tests ?? {})) {
    const test = seen?.tests?.find((entry) => entry.title === title);
    add(`${what}: "${title}" ${status}`, test?.status === status, !test ? `there is no such test (${(seen?.tests ?? []).map((entry) => `"${entry.title}" ${entry.status}`).join('; ') || said})` : `it ${test.status}${test.error ? `: ${test.error.slice(0, 300)}` : ''}`);
  }
  if (expect.artifacts !== undefined) {
    const files = seen?.artifacts ?? [];
    const opening = files.filter((file) => file.opens);
    add(`${what} keep at least ${expect.artifacts} files that open`, opening.length >= expect.artifacts, `${opening.length} of ${files.length} open${files.length > 0 ? `: ${files.map((file) => `${file.name} ${file.opens ? `(${file.contentType}, ${file.size} bytes)` : 'does not open'}`).join('; ')}` : ''}`);
  }
}
