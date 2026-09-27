import type { ToolDefinition } from '@koala/agent-engine';

const PROJECT_ARG = { type: 'string', description: 'The project, by id or name. Optional when this conversation or tree is about one project.' };
const NO_PROJECT = { when: 'no project is named and the run is about none', says: 'to name one, with the person\'s projects' };
const CARD = 'The proposal checks everything it needs itself and answers with exactly what is wrong, so nothing has to be looked up first. Nothing happens until the person applies it on the card, so say what you proposed rather than that it is done.';

const reader = (name: string, summary: string, guidance: string, returns: string, extra: Record<string, { type: string; description: string }> = {}): ToolDefinition => ({
  name,
  summary,
  guidance,
  binding: 'platform',
  effect: 'read',
  idempotent: true,
  openWorld: false,
  status: 'draft',
  returns,
  failures: [NO_PROJECT],
  parameters: { type: 'object', properties: { projectId: PROJECT_ARG, ...extra } },
});

const proposer = (
  name: string,
  summary: string,
  guidance: string,
  properties: Record<string, unknown>,
  required: string[],
  failures: { when: string; says: string }[],
): ToolDefinition => ({
  name,
  summary,
  guidance: `${guidance} ${CARD}`,
  binding: 'platform',
  effect: 'propose',
  idempotent: true,
  openWorld: false,
  status: 'draft',
  returns: 'what was proposed, or that the same proposal is already waiting',
  failures,
  parameters: { type: 'object', properties: properties as never, required },
});

export const PROJECT_TOOLS: ToolDefinition[] = [
  reader(
    'get_project_pipeline',
    'See where a project stands: its state, its latest build and whether that build succeeded',
    'Use this to learn whether a project has built, why a build failed, or which build is deployable.',
    'the project\'s state, its repository and cluster, and its latest build with commit, image and any error',
  ),
  reader(
    'get_project_url',
    'Find where a project\'s deployment is reached, and whether it is healthy',
    'Use this when someone wants the address of a deployed project or whether it is up.',
    'the deployment, its state and its address, or that it is not deployed',
  ),
  reader(
    'get_project_env',
    'List the plain environment variables a project is deployed with — not its secrets',
    'Use this to see a project\'s runtime configuration. Secrets are never here; list_project_secrets names those.',
    'one KEY=value per line, or that there are none',
  ),
  reader(
    'read_project_path',
    'Read a file or list a directory in a project\'s repository',
    'Use this to look at a project\'s code or configuration as it is in its repository.',
    'the file\'s text, or the directory\'s entries',
    { path: { type: 'string', description: 'The path within the repository. Empty for the root.' } },
  ),
  proposer(
    'propose_deploy_app',
    'Propose deploying an app from the catalogue — a database, a model server, a media server — to one of the person\'s clusters',
    'Use this when someone wants a catalogue app running. With no cluster named it goes to the management cluster.',
    {
      appType: { type: 'string', description: 'The catalogue id of the app, like wordpress, qdrant or open-webui.' },
      name: { type: 'string', description: 'What to call the deployment: letters, digits and dashes.' },
      cluster: { type: 'string', description: 'The cluster to deploy to. Leave out for the always-on management cluster.' },
    },
    ['appType', 'name'],
    [
      { when: 'the app is not in the catalogue', says: 'the ids that are' },
      { when: 'the name is taken or unusable', says: 'so' },
      { when: 'the cluster is not the person\'s', says: 'the clusters that are' },
    ],
  ),
  proposer(
    'propose_deploy_project',
    'Propose deploying a project\'s latest successful build (or a named one) to its cluster',
    'Use this when someone wants a project\'s current code running.',
    { projectId: PROJECT_ARG, runId: { type: 'string', description: 'A particular build to deploy. Leave out for the latest successful one.' } },
    [],
    [NO_PROJECT, { when: 'the project has no successful build', says: 'so, and to check get_project_pipeline' }],
  ),
  proposer(
    'propose_project_env',
    'Propose setting plain environment variables on a project — configuration, never secrets',
    'Use this for configuration values like a log level or a feature flag. A credential goes through request_secret instead.',
    { projectId: PROJECT_ARG, env: { type: 'object', description: 'The variables to set, as { KEY: value }. Others are kept.' } },
    ['env'],
    [NO_PROJECT, { when: 'a key is not an environment variable name', says: 'which one' }, { when: 'nothing would change', says: 'so' }],
  ),
  proposer(
    'propose_app_spec',
    'Propose adding an app to the person\'s catalogue from a container image — its ports, environment, volumes and probes — so it can then be deployed like any catalogue app',
    'Use this when someone wants to run something the catalogue does not have. Write the whole spec; it is checked all at once. A credential is never written into env: mark it generate with fromSecret, or leave it for request_secret.',
    {
      spec: {
        type: 'object',
        description: 'The app spec: { id, image, ports: [{ name, port }], env: [{ name, value } | { name, generate, fromSecret }], volumes: [{ name, mountPath, size, type }], resources: { limits: { cpu, memory } }, liveness: { path, port }, readiness: { path, port } }. Probes are an HTTP path and a port — not the Kubernetes httpGet shape.',
      },
    },
    ['spec'],
    [{ when: 'the spec is incomplete or unsafe', says: 'every problem, and that nothing was proposed' }, { when: 'the id is a built-in app', says: 'to pick another id' }],
  ),
  proposer(
    'propose_project_dependency',
    'Propose letting a project use one of the person\'s running services — a database, a queue, a model server',
    'Use this when a project\'s code needs another service. Its address and credentials are mounted as files at deploy, so the code reads them rather than hard-coding them.',
    {
      projectId: PROJECT_ARG,
      service: { type: 'string', description: 'The running service\'s deployment name.' },
      as: { type: 'string', description: 'A name to mount it under, when the default would clash.' },
    },
    ['service'],
    [NO_PROJECT, { when: 'the service cannot be bound', says: 'why' }],
  ),
];
