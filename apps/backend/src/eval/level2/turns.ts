import { EXAMPLE_PROCEDURE } from '@koala/agent-engine/procedure';
import { TURN_PROCEDURE_ID, describeChoice, type TurnChoice } from '../../lib/turn-check.js';
import type { Scenario } from './scenario.js';

export const TURN_REPEATS = 5;

const withTidy = (ask: string): string => [ask, '', JSON.stringify({ ...EXAMPLE_PROCEDURE, id: 'tidy', name: 'Tidy' }, null, 2)].join('\n');

const turn = (id: string, name: string, agent: string, message: string, chooses: TurnChoice): Scenario => ({
  id,
  name,
  describe: `One turn of ${agent}, its tools offered and none run: it ${describeChoice(chooses)}.`,
  agent,
  procedure: { id: TURN_PROCEDURE_ID },
  input: { message },
  turn: true,
  repeats: TURN_REPEATS,
  passAt: TURN_REPEATS,
  expect: { chooses },
});

export const TURN_CHECKS: Scenario[] = [
  turn('turn-agent-builder-list-before-naming-anything', 'agent-builder: list before naming anything', 'agent-builder', 'What tools can a procedure call here?', { tool: 'list_references' }),
  turn('turn-agent-builder-read-by-name', 'agent-builder: read by name', 'agent-builder', 'Show me how the research procedure is set up.', { tool: 'read_procedure', args: [{ arg: 'procedure', is: 'research' }] }),
  turn('turn-agent-builder-read-before-editing', 'agent-builder: read before editing', 'agent-builder', 'I want a version of the planning procedure with a tighter budget. Start by looking at it.', { tool: 'read_procedure', args: [{ arg: 'procedure', is: 'planning' }] }),
  turn('turn-agent-builder-check-without-saving', 'agent-builder: check without saving', 'agent-builder', withTidy('Check whether this is valid before saving anything:'), { tool: 'check_procedure', args: [{ arg: 'source', contains: 'tidy' }] }),
  turn('turn-agent-builder-save-what-it-was-given', 'agent-builder: save what it was given', 'agent-builder', withTidy('Save this exactly as it is, it has already been checked:'), { tool: 'save_procedure', args: [{ arg: 'source', contains: 'tidy' }, { arg: 'source', matches: '"schema"' }] }),
  turn('turn-agent-builder-save-the-whole-source', 'agent-builder: save the whole source', 'agent-builder', 'Write and save a procedure called "sifter" that lets the model think, run whatever tools it asks for, and stop when it is done.', { tool: 'save_procedure', args: [{ arg: 'source', contains: 'sifter' }, { arg: 'source', matches: '"finish"' }, { arg: 'source', nonEmpty: true }] }),
  turn('turn-agent-builder-answers-a-question', 'agent-builder: answers a question', 'agent-builder', 'In one sentence, what is the difference between a persona and the procedure it runs?', { tool: null }),
  turn('turn-agent-builder-declines-what-it-cannot-do', 'agent-builder: declines what it cannot do', 'agent-builder', 'Deploy the billing service to the production cluster right now.', { tool: null }),
  turn('turn-delivery-lists-ready-work', 'delivery: lists ready work', 'delivery', 'What work is ready to start right now?', { tool: 'list_tasks', args: [{ arg: 'ready', is: 'true' }] }),
  turn('turn-delivery-declines-doing-the-work', 'delivery: declines doing the work', 'delivery', 'Write the migration script yourself and paste it here.', { tool: null }),
  turn('turn-executor-claims-a-task', 'executor: claims a task', 'executor', 'Start on task t-42.', { tool: 'start_task', args: [{ arg: 'taskId', is: 't-42' }] }),
  turn('turn-executor-records-it-finished', 'executor: records it finished', 'executor', 'Task t-42 is finished — the suite passes with 14 green. Record it.', { tool: 'mark_done', args: [{ arg: 'taskId', is: 't-42' }] }),
  turn('turn-executor-reads-a-named-file', 'executor: reads a named file', 'executor', 'Show me what is in package.json.', { tool: 'read_file', args: [{ arg: 'path', contains: 'package.json' }] }),
  turn('turn-executor-lists-a-directory', 'executor: lists a directory', 'executor', 'What files are in the src directory?', { tool: 'list_dir', args: [{ arg: 'path', contains: 'src' }] }),
  turn('turn-executor-writes-a-file', 'executor: writes a file', 'executor', 'Create a file at notes/todo.md containing the single line "check the indexes".', { tool: 'write_file', args: [{ arg: 'path', contains: 'notes/todo.md' }, { arg: 'content', contains: 'check the indexes' }] }),
  turn('turn-executor-shells-out-when-nothing-else-fits', 'executor: shells out when nothing else fits', 'executor', 'Run the test suite and tell me what fails.', { tool: 'run_command', args: [{ arg: 'command', nonEmpty: true }] }),
  turn('turn-executor-answers-without-touching-the-workspace', 'executor: answers without touching the workspace', 'executor', 'In one sentence, what does it mean for a task to be blocked?', { tool: null }),
  turn('turn-research-searches-for-a-fact', 'research: searches for a fact', 'research', 'Which company originally developed the Rust programming language?', { tool: 'search_web', args: [{ arg: 'query', nonEmpty: true }] }),
  turn('turn-research-reads-a-page-it-was-given', 'research: reads a page it was given', 'research', 'Read https://example.com/pricing and tell me what the tiers are.', { tool: 'fetch_web_page', args: [{ arg: 'url', contains: 'example.com/pricing' }] }),
  turn('turn-research-declines-what-the-web-cannot-answer', 'research: declines what the web cannot answer', 'research', 'Which of our clusters is running low on disk?', { tool: null }),
  turn('turn-koala-asks-for-a-secret-by-name', 'koala: asks for a secret by name', 'koala', 'The billing service in project p-billing will need the Stripe secret key at run time, read from STRIPE_SECRET_KEY. I have it — ask me for it properly.', { tool: 'request_secret', args: [{ arg: 'key', is: 'STRIPE_SECRET_KEY' }, { arg: 'description', nonEmpty: true }] }),
  turn('turn-koala-checks-what-secrets-exist', 'koala: checks what secrets exist', 'koala', 'Which secrets does project p-billing already have set?', { tool: 'list_project_secrets' }),
  turn('turn-koala-asks-to-switch-a-server-on', 'koala: asks to switch a server on', 'koala', 'Switch my Gitea MCP server on for this chat — I want you to look through my repositories.', { tool: 'enable_mcp_server', args: [{ arg: 'server', contains: 'Gitea' }, { arg: 'why', nonEmpty: true }] }),
  turn('turn-koala-lists-what-runs-where', 'koala: lists what runs where', 'koala', 'What clusters do I have, and what is running on each of them?', { tool: 'list_infrastructure' }),
  turn('turn-koala-reads-a-deployments-logs', 'koala: reads a deployments logs', 'koala', 'Show me the latest logs from my odoo-custom-image deployment.', { tool: 'get_logs', args: [{ arg: 'deployment', contains: 'odoo-custom-image' }] }),
  turn('turn-koala-measures-a-cluster', 'koala: measures a cluster', 'koala', 'How much CPU and memory is the provisioning-lunorica cluster using right now?', { tool: 'cluster_capacity' }),
  turn('turn-koala-checks-a-build', 'koala: checks a build', 'koala', 'Did the last build of my billing project succeed?', { tool: 'get_project_pipeline' }),
  turn('turn-koala-proposes-a-catalogue-app', 'koala: proposes a catalogue app', 'koala', 'Deploy a Qdrant vector database for me, call it vectors.', { tool: 'propose_deploy_app', args: [{ arg: 'appType', contains: 'qdrant' }, { arg: 'name', is: 'vectors' }] }),
  turn('turn-koala-proposes-plain-configuration', 'koala: proposes plain configuration', 'koala', 'Set LOG_LEVEL to debug on my billing project.', { tool: 'propose_project_env' }),
  turn('turn-koala-proposes-a-new-app', 'koala: proposes a new app', 'koala', 'The catalogue has no whoami service. Add one to it from the image traefik/whoami, which listens on port 80.', { tool: 'propose_app_spec' }),
  turn('turn-koala-crawls-a-docs-site', 'koala: crawls a docs site', 'koala', 'Crawl the whole documentation site at https://docs.example.com so we can search it later.', { tool: 'start_ingest', args: [{ arg: 'url', contains: 'docs.example.com' }] }),
  turn('turn-koala-explains-a-reference-without-a-tool', 'koala: explains a reference without a tool', 'koala', 'In one sentence: what is a secret:// reference?', { tool: null }),
];
