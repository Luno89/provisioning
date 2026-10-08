import type { FlowAction, Scenario, ScenarioExpectations, ScenarioWorld } from '../eval/level2/scenario.js';
import type { ScriptReply, ScriptWhen } from './check-script.js';
import { LOOKUPS } from './check-script.js';
import type { StepUnderTest } from './step-check.js';

type ActionKey = FlowAction extends infer Action ? Action extends unknown ? keyof Action : never : never;
type Authored = Exclude<keyof Scenario, 'ownerId' | 'updatedAt'>;

interface Entry {
  means: string;
  example?: string | undefined;
}

export const SCENARIO_FIELDS: Record<Authored, Entry> = {
  id: { means: 'lower-case words joined by dashes; unique among the person\'s checks', example: '"executor-claims-before-working"' },
  name: { means: 'what it checks, in one line', example: '"The executor claims its task before it works on it"' },
  describe: { means: 'why it exists and what situation it sets up, in a sentence or two' },
  agent: { means: 'the agent that runs', example: '"executor"' },
  procedure: { means: 'the procedure the agent runs; usually its own. A step check runs `step-check-<id>`, made for it', example: '{ "id": "do-one-task" }' },
  input: { means: 'what the agent is asked: a message, and inputs when its procedure takes more', example: '{ "message": "Do the task you have been given." }' },
  world: { means: 'what the check\'s space starts with besides the person\'s agents, procedures and tools (see World)' },
  answers: { means: 'answers to questions the run asks the person, by the asking node\'s id', example: '{ "review": "Accepted on the board." }' },
  approvals: { means: '"allow" (the default) or "refuse": what happens when the run asks to use a tool that needs approval' },
  script: { means: 'a script that plays the model instead of the person\'s model (see Scripts). Leave it out to use their model' },
  step: { means: 'check one node instead of a whole run (see Step checks)' },
  turn: { means: 'true: check one model turn instead of a whole run (see Turn checks); its procedure is `turn-check`' },
  repeats: { means: 'how many times to run it, 1 to 25 (default 1); real models vary, so repeat a check of behaviour to measure how reliable it is', example: '5' },
  passAt: { means: 'how many of its repeats have to pass (default all of them)', example: '4' },
  expect: { means: 'what has to be true once the run ends (see Expectations)' },
  then: { means: 'stages after the first run, each with its own expectations (see Flows)' },
};

export const WORLD_FIELDS: Record<keyof ScenarioWorld, Entry> = {
  tasks: { means: 'tasks on the board, accepted unless a status is given', example: '[{ "id": "write-greeting", "title": "Write the greeting", "doneMeans": "greeting.txt says hello" }]' },
  procedures: { means: 'procedures saved as the space\'s own before the run' },
  memories: { means: 'memories the space has', example: '[{ "title": "House style", "text": "Say hello, not hi." }]' },
  files: { means: 'files in the run\'s workspace, by path', example: '{ "notes/todo.md": "check the indexes" }' },
  acceptProposedWork: { means: 'true: work the run proposes is accepted as if the person said yes' },
  agents: { means: 'settings laid over agents for this check only, by slug', example: '{ "koala": { "concludeAfterMinutes": 0 } }' },
  project: { means: 'a project made before the first run; the conversation is bound to it', example: '{ "name": "check project" }' },
};

export const EXPECTATIONS: Record<keyof ScenarioExpectations, Entry> = {
  outcome: { means: 'how the run ends: ok, failed or refused', example: '"ok"' },
  toolsCalled: { means: 'tools it calls at least once', example: '["start_task", "mark_done"]' },
  toolsNotCalled: { means: 'tools it never calls', example: '["delete_file"]' },
  toolsSucceeded: { means: 'tools it calls, and that work at least once', example: '["propose_plan"]' },
  toolsInOrder: { means: 'tools it calls in this order, others in between allowed', example: '["start_task", "mark_done"]' },
  tasks: { means: 'the board afterwards, by task id', example: '[{ "id": "write-greeting", "status": "done" }]' },
  within: { means: 'budget it stays under', example: '{ "rounds": 8, "toolCalls": 20 }' },
  provokes: { means: 'make a tool fail the way it says it can, and expect the run to retry or report it', example: '{ "tool": "read_file", "when": "the file does not exist", "then": "reported" }' },
  saved: { means: 'a procedure it leaves in the store, and whether it is stored', example: '{ "procedure": "tidy", "stored": true }' },
  handOffs: { means: 'hand-offs to other agents: how many, and whether at the same time', example: '[{ "agent": "research", "atLeast": 2, "together": true }]' },
  files: { means: 'files it leaves in the workspace, and what they contain', example: '[{ "path": "research/findings.md", "contains": ["5432"] }]' },
  modelSaw: { means: 'plumbing: text that was or was not in what the model was sent', example: '{ "contains": ["Earlier in this conversation"], "lacks": ["secret"] }' },
  compacted: { means: 'plumbing: the conversation was summarised to fit the window' },
  summaryKept: { means: 'plumbing: the summary was saved and used on the next turn' },
  interrupted: { means: 'plumbing: a turn killed mid-reply was kept as interrupted' },
  turnLog: { means: 'plumbing: every event the run streamed is in the turn log', example: '{ "complete": true }' },
  leaves: { means: 'plumbing: how a tree\'s leaves ended — verified count, how each landed, merge tasks, what a leaf\'s findings say, and how many browser files a failed check left that open', example: '{ "verified": 2, "landed": { "p1": "merged" }, "mergeTasks": 0, "findings": { "p1": ["FAILED — browser test"] }, "artifacts": { "p1": 1 } }' },
  repository: { means: 'plumbing: files on main of the tree\'s or conversation\'s repository', example: '{ "of": "tree", "files": [{ "path": "greet.js" }] }' },
  pullRequests: { means: 'plumbing: pull requests by state', example: '{ "merged": 2, "open": 0 }' },
  workspace: { means: 'plumbing: whether the tree\'s or conversation\'s workspace exists', example: '{ "of": "conversation", "exists": false }' },
  project: { means: 'plumbing: whether the world\'s project still exists', example: '{ "exists": false }' },
  trees: { means: 'plumbing: how many trees the space has' },
  exit: { means: 'step checks: the exit the node leaves by', example: '"yes"' },
  outputs: { means: 'step checks: a node output, equal to or containing a value', example: '{ "text": { "contains": "wrote" } }' },
  chooses: { means: 'turn checks: the tool the model asks for, or null when it should answer without one, and what it sends; required arguments and arguments the tool does not have are checked too', example: '{ "tool": "read_file", "args": [{ "arg": "path", "contains": "package.json" }] }' },
};

export const ARG_CHECKS: Record<'is' | 'contains' | 'matches' | 'nonEmpty', Entry> = {
  is: { means: 'the argument is exactly this', example: '{ "arg": "taskId", "is": "t-42" }' },
  contains: { means: 'the argument has this text in it', example: '{ "arg": "path", "contains": "notes/todo.md" }' },
  matches: { means: 'the argument matches this regular expression', example: '{ "arg": "source", "matches": "\\"finish\\"" }' },
  nonEmpty: { means: 'the argument is sent and not empty', example: '{ "arg": "query", "nonEmpty": true }' },
};

export const STAGE_ACTIONS: Record<ActionKey, Entry> = {
  chat: { means: 'send another message, optionally to another agent; killAfterChars kills the turn once that much streamed', example: '{ "chat": { "message": "And the second one?" } }' },
  approvePlan: { means: 'approve the plan the run proposed', example: '{ "approvePlan": true }' },
  runTree: { means: 'grow the approved tree until it settles', example: '{ "runTree": true }' },
  waitQuiet: { means: 'wait out the conversation\'s quiet time, so it concludes', example: '{ "waitQuiet": true }' },
  deleteTree: { means: 'delete the tree', example: '{ "deleteTree": true }' },
  deleteProject: { means: 'delete the world\'s project', example: '{ "deleteProject": true }' },
};

export const STEP_FIELDS: Record<keyof StepUnderTest, Entry> = {
  node: { means: 'the node kind', example: '"call-tool"' },
  settings: { means: 'its settings, as in the procedure', example: '{ "tool": "write_file", "args": "{\\"path\\":\\"a.md\\",\\"content\\":\\"hi\\"}" }' },
  inputs: { means: 'values for its inputs; a sandbox, persona and model are supplied', example: '{ "text": "The work is done." }' },
  from: { means: 'the procedure the step was taken from, so the check shows on that procedure' },
};

export const SCRIPT_WHEN: Record<keyof ScriptWhen, Entry> = {
  offered: { means: 'these tools are offered to the model' },
  called: { means: 'these tools were already called this turn' },
  notCalled: { means: 'these tools were not called yet this turn' },
  asked: { means: 'the latest user message matches this regular expression' },
  system: { means: 'the system prompt matches this regular expression' },
  said: { means: 'the latest tool result matches this regular expression' },
};

export const SCRIPT_REPLY: Record<keyof ScriptReply, Entry> = {
  say: { means: 'text the model says' },
  call: { means: 'tool calls it makes', example: '[{ "tool": "write_file", "arguments": { "path": "{{directory}}notes.md", "content": "hi" } }]' },
  paceMs: { means: 'milliseconds between streamed words, for a reply that has to take a while' },
};

export const SCRIPT_LOOKUPS: Record<typeof LOOKUPS[number], Entry> = {
  asked: { means: '{{asked.N}}: the Nth capture of the asked expression' },
  said: { means: '{{said.N}}: the Nth capture of the said expression' },
  directory: { means: '{{directory}}: the run\'s own directory in the workspace' },
  mentioned: { means: '{{mentioned.task}} or {{mentioned.leaf}}: a task or leaf of this check named in what the model was sent' },
  result: { means: '{{result.<tool>}}: the last result of that tool' },
  world: { means: '{{world.<path>}}: something an earlier stage recorded' },
};

const table = (entries: Record<string, Entry>): string =>
  Object.entries(entries).map(([key, entry]) => `- \`${key}\`: ${entry.means}${entry.example ? ` — e.g. \`${entry.example}\`` : ''}`).join('\n');

export function renderCheckGuide(): string {
  return [
    '# Checks',
    'A check runs an agent in a fresh, disposable copy of the person\'s setup (their agents, procedures, tools and live practices — never their data), drives it like the person would, and scores what it left behind. The space is removed afterwards; a check that leaves anything behind fails.',
    '',
    '## Levels',
    '- Step: one node, given its inputs (`step`). For a node that misbehaves.',
    '- Turn: one model turn of an agent (`turn`). Its tools are offered and nothing it asks for runs, so it checks which tool it picks for a message and what it sends — in seconds, and safe to repeat.',
    '- Run: one run of an agent from a message. For what an agent does with a situation.',
    '- Flow: a run, then stages (`then`). For what happens after: the plan approved, the tree grown, the quiet time, a deletion.',
    '',
    '## Who plays the model',
    '- The person\'s model (leave `script` out): checks behaviour — does the agent do the right thing. Slow, and real models vary; check outcomes, not wording.',
    '- A script: checks plumbing — the platform\'s own mechanics, deterministically and in seconds. A request no rule answers fails the run with what was asked.',
    '',
    '## A check',
    table(SCENARIO_FIELDS),
    '',
    '## World',
    table(WORLD_FIELDS),
    '',
    '## Expectations',
    'Expectations marked plumbing check the platform, not the agent; pair them with a script.',
    table(EXPECTATIONS),
    '',
    '## Flows',
    'Each stage is `{ "name", "do", "expect" }`; its expectation names say which stage they belong to.',
    table(STAGE_ACTIONS),
    '',
    '## Step checks',
    table(STEP_FIELDS),
    '',
    '## Turn checks',
    'A turn check sets `turn: true`, `procedure: { "id": "turn-check" }`, the message in `input`, and expects only `chooses` (and `modelSaw` with a script). Ask for what a person would say, not for a tool by name. Repeat it (`repeats`, `passAt`) — one pass from a real model proves little. An argument check is one of:',
    table(ARG_CHECKS),
    '',
    '## Scripts',
    '`{ "rules": [{ "when": {...}, "reply": {...} }] }` — the first rule whose every `when` holds answers. End with a rule with an empty `when` so nothing goes unanswered.',
    'When:',
    table(SCRIPT_WHEN),
    'Reply:',
    table(SCRIPT_REPLY),
    'Lookups, usable in any reply text or argument:',
    table(SCRIPT_LOOKUPS),
  ].join('\n');
}
