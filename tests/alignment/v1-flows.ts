import type { Flow } from './flow-spec.js';

const UI = 'apps/frontend/src/features';

export const V1_FLOWS: Flow[] = [
  {
    id: 'A',
    title: 'Get an account',
    who: 'At root',
    steps: [
      {
        id: 'A1',
        does: 'The person opens root\'s invite link and signs up with the invited address, confirming it with an emailed code.',
        screen: { on: 'root', component: `${UI}/accounts/components/Login.tsx#default` },
        decisions: [],
        assumed: 'Built before the register (CLAUDE.md, Auth); no decision of the owner\'s is recorded for it yet.',
      },
      {
        id: 'A2',
        does: 'Signed in with no Koala yet, root\'s page offers Add a machine (and a trial on Koala\'s servers, outside v1).',
        screen: { on: 'root', component: `${UI}/instances/components/NoInstance.tsx#default` },
        decisions: ['adding-a-machine-is-the-product', 'koala-on-a-machine', 'pool'],
      },
    ],
  },
  {
    id: 'B',
    title: 'Join a machine',
    who: 'Root\'s Add a machine, then a terminal on the person\'s computer',
    steps: [
      {
        id: 'B1',
        does: 'Add a machine shows one command, with "Put my Koala on this machine" ticked when they have no Koala yet. The code works once and lasts an hour.',
        screen: { on: 'root', component: `${UI}/machines/components/AccountMachines.tsx#default` },
        decisions: ['adding-a-machine-is-the-product', 'koala-on-a-machine'],
      },
      {
        id: 'B2',
        does: 'They run it as themselves. It brings its own pinned Node, asks which folder Koala may work in, joins the mesh and installs the machine agent as a user service.',
        screen: { on: 'terminal' },
        decisions: ['agents-on-the-host', 'pins', 'side-with-the-user'],
      },
      {
        id: 'B3',
        does: 'The agent finds the coding agents on the computer and offers to install any missing adapters.',
        screen: { on: 'terminal' },
        decisions: ['agents-on-the-host'],
      },
      {
        id: 'B4',
        does: 'The machine gets its one cluster, installed but stopped. Koala never installs Docker.',
        screen: { on: 'terminal' },
        decisions: ['one-cluster-per-machine', 'how-a-machine-cluster-is-made', 'cluster-on-demand'],
        branches: [
          { when: 'A GPU is found', outcome: 'One plain question: "Run models on this GPU? It needs your password once to set it up."', decision: 'how-a-machine-cluster-is-made' },
          { when: 'They say yes', outcome: 'k3s on the host, the only way to pass a GPU through', decision: 'how-a-machine-cluster-is-made' },
          { when: 'No GPU, or they say no, and Docker is already there', outcome: 'k3d in their Docker: no password, nothing installed', decision: 'how-a-machine-cluster-is-made' },
          { when: 'No GPU, or they say no, and no Docker', outcome: 'k3s on the host (password once)', decision: 'how-a-machine-cluster-is-made' },
        ],
        assumed: 'Asking only when a GPU is found.',
      },
      {
        id: 'B5',
        does: 'The GPU toolkit is offered at join when a GPU is found; B4\'s question is that offer.',
        screen: { on: 'terminal' },
        decisions: ['gpu-is-core'],
      },
      {
        id: 'B6',
        does: 'On a Mac, the cluster is Colima with k3s; models run natively on the host; a Mac can hold Koala. After v1.',
        screen: { on: 'terminal' },
        decisions: ['how-a-machine-cluster-is-made', 'mac-inference-native', 'koala-on-a-machine'],
      },
      {
        id: 'B7',
        does: 'The machine shows on My Machines: online, its cluster stopped, its GPUs listed.',
        screen: { on: 'instance', route: '/mesh', component: `${UI}/machines/components/MyMachines.tsx#default` },
        decisions: ['adding-a-machine-is-the-product', 'gpu-is-core'],
      },
    ],
  },
  {
    id: 'C',
    title: 'Koala lands on the machine',
    who: 'No action from the person; root\'s page shows progress',
    steps: [
      {
        id: 'C1',
        does: 'With the box ticked, the agent starts the cluster, installs Koala from root\'s checked chart and reports: waiting, installing, ready or failed with why.',
        screen: { on: 'root', component: `${UI}/instances/components/NoInstance.tsx#default` },
        decisions: ['koala-on-a-machine'],
      },
      {
        id: 'C2',
        does: 'When ready, root sends them to their Koala at <name>.<people\'s domain>.',
        screen: { on: 'root', component: `${UI}/instances/components/NoInstance.tsx#default` },
        decisions: ['koala-on-a-machine'],
      },
      {
        id: 'C3',
        does: 'While Koala is on the machine and it is on power, the agent keeps it from sleeping, and My Machines says so.',
        screen: { on: 'instance', route: '/mesh', component: `${UI}/machines/components/MyMachines.tsx#default` },
        decisions: ['machine-lifecycle'],
      },
      {
        id: 'C4',
        does: 'Koala itself runs on a k3d machine as on a k3s one; only GPU models need k3s.',
        screen: { on: 'machine' },
        decisions: ['how-a-machine-cluster-is-made', 'side-with-the-user'],
      },
    ],
  },
  {
    id: 'D',
    title: 'Sign in',
    who: 'Their Koala',
    steps: [
      {
        id: 'D1',
        does: 'Signed out, their Koala sends them to root to sign in, which hands them back.',
        screen: { on: 'instance', component: `${UI}/accounts/components/Login.tsx#default` },
        decisions: ['v1', 'root'],
      },
      {
        id: 'D2',
        does: 'If the sign-in options cannot be loaded, the page says so in one line and nothing of why; the reason is recorded on the server.',
        screen: { on: 'instance', component: `${UI}/accounts/components/Login.tsx#default` },
        decisions: ['errors-to-people'],
      },
      {
        id: 'D3',
        does: 'With no default model yet, they are asked for one; in v1 the way is a model on their own machine.',
        screen: { on: 'instance', component: `${UI}/models/components/FirstModel.tsx#FirstModel` },
        decisions: ['v1'],
      },
    ],
  },
  {
    id: 'E',
    title: 'Run a model on their GPU',
    who: 'Infrastructure on their Koala',
    steps: [
      {
        id: 'E1',
        does: 'Infrastructure\'s sections are clearly divided, and with no app yet, deploying one is the obvious thing on the page. Deploy opens the catalogue; they pick TabbyAPI or vLLM, the machine, the model and how many GPUs, the GPUs offered from the machine\'s own report.',
        screen: { on: 'instance', route: '/infrastructure', component: `${UI}/infrastructure/components/AppsSection.tsx#AppsSection` },
        decisions: ['deploy-from-a-catalogue', 'gpu-is-core'],
      },
      {
        id: 'E2',
        does: 'GPUs asked for but unusable: the deploy is refused with what to fix. CPU only when they pick 0 GPUs.',
        screen: { on: 'instance', component: `${UI}/infrastructure/components/AppDeployWizard/index.tsx#default` },
        decisions: ['gpu-unusable'],
      },
      {
        id: 'E3',
        does: 'The machine offline: the deploy waits with no deadline, Needs attention says why, and it goes ahead when the machine connects.',
        screen: { on: 'instance', route: '/infrastructure', component: `${UI}/infrastructure/components/Overview.tsx#Overview` },
        decisions: ['machine-lifecycle'],
      },
      {
        id: 'E4',
        does: 'The deploy starts the machine\'s cluster and readies its GPUs, proved by a pod that sees them.',
        screen: { on: 'machine' },
        decisions: ['cluster-on-demand', 'gpu-is-core'],
      },
      {
        id: 'E5',
        does: 'The model downloads on that machine, into its own cache, and the app\'s page shows the download.',
        screen: { on: 'instance', component: `${UI}/infrastructure/components/AppDashboard/index.tsx#default` },
        decisions: ['gpu-is-core'],
        assumed: 'The app\'s page showing the download.',
      },
      {
        id: 'E6',
        does: 'The app runs and answers; its page shows its health and address.',
        screen: { on: 'instance', component: `${UI}/infrastructure/components/AppDashboard/index.tsx#default` },
        decisions: ['monitoring-per-person'],
      },
      {
        id: 'E7',
        does: 'Apps lists only what was just read. An unreachable machine shows as unavailable, with why, and its apps are not listed. Reading never deletes or marks synced.',
        screen: { on: 'instance', route: '/infrastructure', component: `${UI}/infrastructure/components/AppsSection.tsx#AppsSection` },
        decisions: ['what-apps-show', 'saved-only-when-true'],
      },
      {
        id: 'E8',
        does: 'What Koala did not deploy shows only on the cluster\'s page as put there another way. The discover routes go.',
        screen: { on: 'instance', route: '/infrastructure/cluster/$id', component: `${UI}/infrastructure/components/ClusterPage.tsx#ClusterPage` },
        decisions: ['what-apps-show', 'no-koala-made-k3d-clusters'],
      },
      {
        id: 'E9',
        does: 'Destroying the last app on a machine that does not hold Koala stops its cluster at once.',
        screen: { on: 'machine' },
        decisions: ['cluster-on-demand'],
      },
    ],
  },
  {
    id: 'F',
    title: 'Chat with their own model',
    who: 'Studio, then Koala',
    steps: [
      {
        id: 'F1',
        does: 'The running model is offered as a model; they make it the default.',
        screen: { on: 'instance', route: '/studio/models', component: `${UI}/models/components/ModelsView.tsx#default` },
        decisions: ['v1'],
      },
      {
        id: 'F2',
        does: 'A chat turn runs on that model and answers. If its server is not answering, the turn says so and never falls back to another model.',
        screen: { on: 'instance', route: '/chat', component: `${UI}/engine/components/ChatPage.tsx#default` },
        decisions: ['v1', 'no-silent-fallbacks'],
      },
    ],
  },
  {
    id: 'G',
    title: 'More machines, and removing one',
    who: 'My Machines',
    steps: [
      {
        id: 'G1',
        does: 'A second machine joins the same way with the box unticked, and waits stopped until something is deployed to it.',
        screen: { on: 'instance', route: '/mesh', component: `${UI}/machines/components/MyMachines.tsx#default` },
        decisions: ['adding-a-machine-is-the-product', 'cluster-on-demand', 'koala-on-a-machine'],
      },
      {
        id: 'G2',
        does: 'Removing a machine lists its apps, asks once, then destroys them with it; removing the one holding Koala removes Koala too, typed to confirm.',
        screen: { on: 'instance', route: '/mesh', component: `${UI}/machines/components/MyMachines.tsx#default` },
        decisions: ['machine-lifecycle'],
      },
    ],
  },
  {
    id: 'H',
    title: 'Koala updates itself',
    who: 'Settings on their Koala',
    steps: [
      {
        id: 'H1',
        does: 'On automatic updates, their Koala moves to root\'s newer release and rolls itself back, telling root why, when a new pod cannot recover.',
        screen: { on: 'nowhere' },
        decisions: [],
        assumed: 'Built before the register (CLAUDE.md, Releases); no decision of the owner\'s is recorded for it yet.',
      },
      {
        id: 'H2',
        does: 'Picking a release: their Koala first checks it can start the upgrade, and only then does root record the pick; otherwise nothing is saved and the page says why.',
        screen: { on: 'instance', route: '/settings', component: `${UI}/instances/components/InstanceUpdates.tsx#InstanceUpdates` },
        decisions: ['saved-only-when-true'],
      },
    ],
  },
  {
    id: 'I',
    title: 'Developing Koala',
    who: 'The owner, on this computer',
    steps: [
      {
        id: 'I1',
        does: 'npm run dev brings up root with its own k3s in a small VM, this computer joined as a machine and Koala on it, with watchers, quiet output and its monitoring through the local collector.',
        screen: { on: 'terminal' },
        decisions: ['dev-runs-like-prod'],
      },
      {
        id: 'I2',
        does: 'This computer\'s machine cluster is k3s with both 3090s, so flow E runs here for real.',
        screen: { on: 'machine' },
        decisions: ['dev-runs-like-prod', 'gpu-is-core'],
      },
    ],
  },
  {
    id: 'X',
    title: 'Across every flow',
    who: 'Everywhere',
    steps: [
      {
        id: 'X1',
        does: 'A failure is recorded on the server with its full reason; the person is told in plain words what went wrong and what they can do, never internals.',
        screen: { on: 'nowhere' },
        decisions: ['errors-to-people'],
      },
    ],
  },
];
