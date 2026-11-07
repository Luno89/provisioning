export interface Words {
  at: string;
  text: string;
  asked?: string;
  answering?: string;
}

export interface Decision {
  id: string;
  subject: string;
  terms: string[];
  words: Words[];
  reading: string;
  replaced?: Array<{ words: Words; by: string }>;
}

export const DECISIONS: Decision[] = [
  {
    id: 'side-with-the-user',
    subject: 'How product questions are settled',
    terms: ['sudo', 'invasive', 'install'],
    words: [
      { at: '2026-11-06T22:05', text: 'the idea is to always side with the user and whatever decision makes it easier and less invasive to them' },
      { at: '2026-11-06T22:06', text: 'so if a dependency needs sudo for no reason then we don\'t do it' },
      { at: '2026-11-06T22:06', text: 'as just one example' },
      { at: '2026-11-06T22:06', text: 'not me, the user' },
    ],
    reading: 'A product question goes to whichever answer is easier and less invasive for whoever uses Koala. It never overrules an explicit answer of the owner\'s; a conflict between the two is asked.',
  },
  {
    id: 'v1',
    subject: 'What v1 is and the order of work',
    terms: ['v1', 'structural'],
    words: [
      { at: '2026-11-06T05:51', text: 'I\'m looking for structual changes in how we work cause its been like three months and we haven\'t really gotten anywhere' },
      { at: '2026-11-06T05:58', text: 'yes, the GPU machine story is v1, and your going to do all the structural changes first right?' },
    ],
    reading: 'v1 is a person joining their GPU machine, Koala running on it, deploying TabbyAPI or vLLM and chatting with their own model, signed in through root. The structural changes come before v1 work.',
  },
  {
    id: 'adding-a-machine-is-the-product',
    subject: 'A machine: what it is and where it is added',
    terms: ['My Machines', 'machine.sh', 'join'],
    words: [
      { at: '2026-11-04T01:05', text: 'Yeah we need to fix this, this is the whole point of the project, adding a machine is the core product' },
      { at: '2026-11-04T03:44', asked: 'Where does a person add a machine: to their account on root, or inside their Koala (the instance)?', text: 'Account on root (Recommended)' },
      { at: '2026-11-04T03:44', asked: 'Is a machine only ever one person\'s, or can several people\'s work run on one machine (a team\'s GPU server)?', text: 'One person\'s (Recommended)' },
      { at: '2026-11-04T04:00', asked: 'How many machines can one account add?', text: 'No limit (Recommended)' },
      { at: '2026-11-04T03:48', asked: 'Machines already set up the old ways (an instance from install.sh, a machine from machine.sh): how do they come over?', text: 'Run the new command (Recommended)' },
    ],
    reading: 'A machine is added to the person\'s account at root, is one person\'s only, and there is no limit on how many. Machines set up the old ways come over by running the new command.',
  },
  {
    id: 'one-path',
    subject: 'One way to do each job',
    terms: ['two paths', 'second path', 'Your own hardware'],
    words: [
      { at: '2026-11-04T00:32', text: 'There shouldn\'t be two paths, you fucked that up, my machines should have been a refactor of the same thing and it should be implemented as a cluster?' },
    ],
    reading: 'A new feature that overlaps an existing one refactors it into one path.',
  },
  {
    id: 'one-cluster-per-machine',
    subject: 'A machine is one cluster; there is one kind of cluster',
    terms: ['cluster', 'provisioning-lunorica', 'isSystem'],
    words: [
      { at: '2026-11-04T03:39', text: 'there should probably only be one cluster on one machine that gets added to a user\'s account' },
      { at: '2026-11-05T17:40', text: 'No we can\'t have different kind of clusters' },
    ],
    reading: 'Every machine is exactly one cluster, and the cluster record has one kind: a machine\'s.',
  },
  {
    id: 'how-a-machine-cluster-is-made',
    subject: 'k3s, k3d or Colima',
    terms: ['k3d', 'k3s', 'Colima', 'Docker', 'sudo'],
    words: [
      { at: '2026-11-04T03:39', text: 'kds instance if the user wants to use a gpu app otherwise the other cluster types, metal on mac' },
      { at: '2026-11-04T03:51', asked: 'On a Mac, what provides the Linux VM and the cluster (which can also hold Koala)?', text: 'Colima with k3s (Recommended)' },
      { at: '2026-11-06T05:19', text: '1 - there was some reason that k3d was better if you didn\'t need the passthrough, so users who don\'t need gpu workflows might pick k3d.' },
      { at: '2026-11-06T05:21', asked: 'k3d: you remember a reason it was better when passthrough isn\'t needed.', text: 'How a machine\'s cluster is made (Recommended)' },
      { at: '2026-11-06T21:41', asked: 'Decision 1 of 5: the two "discover" routes.', text: 'I thought the k3d was staying because some users might just be deploying images without the need for sudo?' },
      { at: '2026-11-06T22:04', text: 'it should be apparent that a user who doesn\'t need to host a gpu workload gets k3d and k3s or which ever way it is I don\'t remember' },
      { at: '2026-11-06T22:29', text: 'avoid docker if you can' },
      { at: '2026-11-06T22:31', asked: '"Avoid docker if you can" meets step B4 (joining a Linux machine without a GPU).', text: 'k3d only if Docker is there' },
      { at: '2026-11-06T23:42', answering: 'B4: the join asks its one question only when it finds a GPU; without one it asks nothing.', text: 'B4 - yep' },
    ],
    reading: 'Linux: a GPU found and wanted gets k3s (the only passthrough); the join asks only when it finds a GPU. Otherwise k3d when Docker is already there, else k3s. Koala never installs Docker. A Mac gets Colima with k3s. Koala itself may run on any of them.',
  },
  {
    id: 'no-koala-made-k3d-clusters',
    subject: 'Koala making k3d clusters beside itself',
    terms: ['k3d provider', 'local test clusters', 'discover'],
    words: [
      { at: '2026-11-04T03:51', asked: 'Koala\'s Docker-based extra clusters ("local test clusters": k3d clusters made beside the instance, which is why install.sh installs Docker and mounts its socket). With one cluster per machine:', text: 'Drop them (Recommended)' },
    ],
    reading: 'The k3d provider, Koala making a k3d cluster beside itself, goes, and with it the cluster discovery that only finds those.',
  },
  {
    id: 'cluster-on-demand',
    subject: 'When a machine\'s cluster runs',
    terms: ['start', 'stop', 'idle'],
    words: [
      { at: '2026-11-04T00:50', text: 'so maybe dynamically create a cluster ? so if we never need a workspace or an app we don\'t waste resources on a cluster? unless it doesn\'t cost much' },
      { at: '2026-11-04T01:08', asked: 'When the last thing on a machine\'s cluster ends, when does k3s stop?', text: 'At once (Recommended)' },
    ],
    reading: 'A machine\'s cluster starts when something needs it and stops the moment nothing is left on it.',
  },
  {
    id: 'koala-on-a-machine',
    subject: 'Where the person\'s Koala lives',
    terms: ['Put Koala here', 'instance'],
    words: [
      { at: '2026-11-04T03:44', asked: 'A person with several machines: which one holds their Koala?', text: 'They pick; can move later (Recommended)' },
      { at: '2026-11-04T04:01', asked: 'A person with no Koala yet adds their first machine from root. Does Koala go on it?', text: 'Yes by default, can untick (Recommended)' },
      { at: '2026-11-04T03:46', asked: 'Can a Mac hold the person\'s Koala itself, or only be a machine it uses?', text: 'A Mac can hold it too' },
      { at: '2026-11-04T03:52', asked: '"Put Koala here" on a machine: what actually installs Koala (the instance chart) into that machine\'s cluster?', text: 'The machine agent (Recommended)' },
      { at: '2026-11-04T04:12', asked: 'Koala moves from machine A to machine B. The apps already running on A\'s cluster:', text: 'Stay on A (Recommended)' },
    ],
    reading: 'The first machine gets Koala by default (the box can be unticked); with several, the person picks and can move it later. The machine agent installs it. Apps stay where they were deployed when Koala moves.',
  },
  {
    id: 'agents-on-the-host',
    subject: 'Coding agents and the machine agent run on the host',
    terms: ['bare metal', 'ACP', 'coding agent'],
    words: [
      { at: '2026-11-04T00:42', text: 'I don\'t think its worth making the user sign-in again, so that maybe should stay bare metal' },
      { at: '2026-11-04T00:50', text: 'What we\'re doing is allowed, its just a terminal adapter basically, It would be assumed that adding My Machine entry and kinda the whole point is to be able to run images on it and have their subscriptions be avaliable to use like they are now' },
      { at: '2026-11-04T03:48', asked: 'The join command needs root for k3s and the GPU toolkit, but the agent and coding agents run as the person. How is it run?', text: 'As the person, sudo asked (Recommended)' },
      { at: '2026-11-04T03:54', asked: 'The machine agent is Node.js, and today the join refuses a computer without Node 20+ (the Claude and Codex adapters want Node 22). For one-command setup:', text: 'Bring its own Node (Recommended)' },
      { at: '2026-11-04T03:52', asked: 'Once machines belong to the account on root, who does a machine\'s agent talk to?', text: 'Root and their Koala (Recommended)' },
      { at: '2026-11-04T04:12', asked: 'A machine\'s agent updates itself. Whose release does it follow, when root and the person\'s Koala can be on different releases?', text: 'Their Koala\'s (Recommended)' },
    ],
    reading: 'The machine agent and the coding agents run on the host as the person, using their own sign-ins; the join runs as them and asks for sudo only where it must; it brings its own Node. The agent talks to root and to their Koala and follows their Koala\'s release.',
  },
  {
    id: 'koala-work-in-pods',
    subject: 'Koala\'s own work on a machine',
    terms: ['sandbox', 'host exec', 'pods only'],
    words: [
      { at: '2026-11-06T05:33', asked: 'Decision 9, sandboxes on a machine.', text: 'Refuse; pods only (Recommended)' },
      { at: '2026-11-04T01:08', asked: 'A project whose files live on the person\'s machine: how does its workspace pod see that folder?', text: 'Mount it, as them (Recommended)' },
      { at: '2026-11-04T04:12', asked: 'Browsing or dropping files into a project that lives in the person\'s own folder: through a pod (starting k3s just to list files) or the agent?', text: 'Agent reads/writes the folder (Recommended)' },
    ],
    reading: 'Everything Koala runs on a machine is a pod; without the cluster it is refused, never run on the host. A workspace mounts the person\'s folder as them; browsing files goes through the agent without starting the cluster.',
  },
  {
    id: 'gpu-is-core',
    subject: 'Running their own models on their GPUs',
    terms: ['GPU', 'passthrough', 'TabbyAPI', 'vLLM', 'nvidia'],
    words: [
      { at: '2026-11-06T04:15', text: 'we need the gpu passthrough to be hooked up' },
      { at: '2026-11-06T04:36', text: 'most of the clusters people will use will need to be capable of the gpu passthrough like the k3s was, being able to host their own models with tabby or vllm is a core feature' },
      { at: '2026-11-04T03:46', asked: 'A Linux machine with an NVIDIA or AMD GPU joins. The GPU driver and container toolkit:', text: 'Offered at join (Recommended)' },
      { at: '2026-11-06T04:26', asked: 'How should this be proved live? Only this computer has GPUs, and ship runs on this dev stack.', text: 'A GPU suite in ship (Recommended)' },
    ],
    reading: 'Hosting their own models with TabbyAPI or vLLM on their own GPUs is core. The toolkit is offered at join when a GPU is found, and a GPU suite in ship proves it.',
  },
  {
    id: 'gpu-unusable',
    subject: 'GPUs asked for but unusable',
    terms: ['CPU', 'GPU check', 'refuse'],
    words: [
      { at: '2026-11-06T04:26', asked: 'On a machine\'s cluster, what should happen when GPUs were asked for but can\'t be used?', text: 'Like the dev environment needs the correct dev setup to do the passthrough' },
      { at: '2026-11-06T05:21', asked: 'When someone deploys vLLM or TabbyAPI asking for GPUs on a machine that can\'t give them', text: 'Refuse, say what to fix (Recommended)' },
    ],
    reading: 'A deploy asking for GPUs a machine cannot give is refused with what to fix; CPU only when the person picks no GPUs.',
  },
  {
    id: 'mac-inference-native',
    subject: 'Models on a Mac',
    terms: ['mlx', 'Metal', 'Mac'],
    words: [
      { at: '2026-11-04T00:57', text: '22 percent is allot to pay just to have it on a cluster, maybe we should look at running a native option, how much are we paying having tabby in the cluster' },
      { at: '2026-11-04T03:48', asked: 'Which native inference servers should a Mac offer first? (Linux keeps TabbyAPI and vLLM in its cluster.)', text: 'mlx-lm (Recommended), llama.cpp with Metal, vLLM-Metal' },
      { at: '2026-11-04T03:48', asked: 'Windows machines?', text: 'Not now (Recommended)' },
      { at: '2026-11-04T03:58', asked: 'Which Mac would be the gate machine?', text: 'One I own (Apple silicon)' },
    ],
    reading: 'On a Mac models run natively on the host (mlx-lm, llama.cpp with Metal, vLLM-Metal), proved on the owner\'s Apple-silicon Mac. No Windows for now.',
  },
  {
    id: 'machine-lifecycle',
    subject: 'Offline, sleep, removal, networks',
    terms: ['offline', 'sleep', 'remove', '6443', 'mesh'],
    words: [
      { at: '2026-11-04T03:46', asked: 'A machine goes offline (laptop closed, power cut). What happens to work meant for it?', text: 'It waits, and says so (Recommended)' },
      { at: '2026-11-04T03:57', asked: 'When Koala itself lives on a Mac (or a Linux laptop), sleep takes it down. Should the agent keep that machine awake?', text: 'Awake on power (Recommended)' },
      { at: '2026-11-04T03:46', asked: 'Removing a machine that still has apps on its cluster:', text: 'Destroy them with it' },
      { at: '2026-11-04T03:52', asked: 'Removing the machine that holds the person\'s Koala:', text: 'Remove Koala with it' },
      { at: '2026-11-04T04:12', asked: 'k3s on a laptop answers its API (6443) and kubelet (10250) on every network the laptop joins, and takes ports 80/443. On machines:', text: 'Mesh and loopback only (Recommended)' },
      { at: '2026-11-04T03:57', asked: 'Which Linux systems does adding a machine promise to work on (proven in the suites), versus best effort?', text: 'Ubuntu, Debian, Fedora' },
    ],
    reading: 'Work for an offline machine waits and says so. A machine with Koala stays awake on power. Removing a machine destroys its apps, and Koala if it holds it. A machine\'s cluster answers only on the mesh and loopback. Ubuntu, Debian and Fedora are promised.',
  },
  {
    id: 'root',
    subject: 'Root and its one cluster',
    terms: ['root', 'root cluster', 'watcher'],
    words: [
      { at: '2026-11-06T00:08', text: 'there should only be one root cluster, and then a user gets their own cluster and their own monitoring, so I\'m focused on the root node, how is it being monitored?' },
      { at: '2026-11-06T00:13', text: 'yes root keeps its k3s, I believe I said one cluster you need to make sure my intention is understood before decided to reword what I said' },
      { at: '2026-11-06T00:13', text: 'for 4 we can have admins be able to add their machines as root node watchers and be able to failover alerts' },
      { at: '2026-11-06T00:16', asked: 'When root is down, how should a watcher machine alert the admins?', text: 'Push from the watcher (Recommended)' },
    ],
    reading: 'Root keeps one k3s cluster of its own, for its monitoring and the pool. Admins can add machines as watchers of root, which push alerts when root is down.',
  },
  {
    id: 'monitoring-per-person',
    subject: 'Monitoring what people deploy',
    terms: ['monitoring', 'metrics', 'Prometheus'],
    words: [
      { at: '2026-11-05T15:24', text: 'well we need to monitor whatever gets deployed there, I\'m not familar enough with those products to know, but can we have one instance of those running in one place and have multiple machines be tracked through it?' },
      { at: '2026-11-05T15:31', text: 'yep build it that way, add it to the plan' },
      { at: '2026-11-05T23:42', text: 'we also need to make sure that users will be able to see their own metrics' },
    ],
    reading: 'One monitoring stack per person\'s Koala tracks all their machines, and each person sees their own metrics.',
  },
  {
    id: 'deploy-from-a-catalogue',
    subject: 'Finding the app catalogue',
    terms: ['catalogue', 'catalog', 'Deploy an app', 'Infrastructure page'],
    words: [
      { at: '2026-11-06T04:11', text: 'Its working, I\'m in, where is the catalouge of apps I can click through and deploy, it should have stayed around somewhere' },
      { at: '2026-11-06T22:41', text: 'it existed it just wasn\'t obvious on the infrastructure page the sections aren\'t well divided and when there wasn\'t a app deployed already the whole button wasn\'t abvoius' },
    ],
    reading: 'Deploying starts from the catalogue of apps, which exists. It has to be easy to find: the Infrastructure page\'s sections are clearly divided, and with no app deployed yet, deploying one is the obvious thing on the page.',
  },
  {
    id: 'what-apps-show',
    subject: 'What the Apps list and the cluster page show',
    terms: ['discover', 'unavailable', 'Apps list'],
    words: [
      { at: '2026-11-06T17:34', text: '3 - I mean I feel like we shouldn\'t have apps just showing up on the cluster?' },
      { at: '2026-11-06T17:34', text: '4 - the front-end and back-end should align on what to show.' },
      { at: '2026-11-06T17:34', text: '10 - I wouldn\'t show a list that hasn\'t been verified, if a cluster is unavalible just show that' },
    ],
    reading: 'Only what Koala deployed is listed as an app. A list shows only what was just read; an unreachable cluster shows as unavailable. Frontend and backend types agree.',
  },
  {
    id: 'saved-only-when-true',
    subject: 'Recording state',
    terms: ['save', 'verified', 'requested'],
    words: [
      { at: '2026-11-06T17:34', text: '14 - root shouldn\'t save anything until its actually true and verified' },
    ],
    reading: 'Nothing is recorded as so until it has been verified.',
  },
  {
    id: 'errors-to-people',
    subject: 'What a person is told when something fails',
    terms: ['error', 'login errors', 'errorResponder'],
    words: [
      { at: '2026-11-06T17:34', text: '8 - we probably don\'t want to expose any login errors to the user as thats a security thing but we should report that somewhere probably' },
      { at: '2026-11-06T17:34', text: '15 - that all sounds like coding errors, showing it to the user is meaningless, are you asking not to fix it?' },
    ],
    reading: 'Failures are recorded on the server; the person is told in plain words and never shown internals. A swallowed error is a coding error to fix, not a question.',
  },
  {
    id: 'no-silent-fallbacks',
    subject: 'Skips, fallbacks and second paths',
    terms: ['fallback', 'skip', 'warn', '|| \''],
    words: [
      { at: '2026-11-06T04:43', text: 'Ok you need to never do half assed shit like "skip" or fallback without making it explicit to me first, everything needs to be implemted cleanly' },
      { at: '2026-11-06T05:33', asked: 'Decision 8, Temporal unreachable.', text: 'Required; say it\'s down (Recommended)' },
      { at: '2026-11-06T05:33', asked: 'Decision 10, web search and page fetch.', text: 'One source each, errors shown (Recommended)' },
      { at: '2026-11-06T05:38', asked: 'Decision 11, memory recall.', text: 'Fail visibly (Recommended)' },
      { at: '2026-11-06T05:38', asked: 'Decision 12, artifacts.', text: 'MinIO only (Recommended)' },
    ],
    reading: 'No skip, fallback or second path without asking first. Temporal is required and its absence is said; web search and fetch have one source each; memory recall fails visibly; artifacts live only in MinIO.',
  },
  {
    id: 'providers',
    subject: 'Cloud providers and mock cloud',
    terms: ['Hetzner', 'DigitalOcean', 'mock cloud', 'OVH'],
    words: [
      { at: '2026-11-06T05:19', text: '2 - we can remove mock cloud mode, I don\'t even know what that is. 3 - we can remove them, they are too expensive.' },
      { at: '2026-11-04T03:51', asked: 'Servers Koala buys or makes for a person (Hetzner, DigitalOcean, the OVH marketplace plan): are they machines too?', text: 'Yes, same join (Recommended)' },
    ],
    reading: 'Mock cloud mode and Hetzner and DigitalOcean go. A server Koala buys (OVH) is a machine joined the same way.',
    replaced: [{ words: { at: '2026-11-04T03:51', asked: 'Servers Koala buys or makes for a person (Hetzner, DigitalOcean, the OVH marketplace plan): are they machines too?', text: 'Yes, same join (Recommended)' }, by: 'Hetzner and DigitalOcean removed on 2026-11-06: "we can remove them, they are too expensive"' }],
  },
  {
    id: 'pool',
    subject: 'Trial instances on Koala\'s servers',
    terms: ['pool', 'trial'],
    words: [
      { at: '2026-11-05T17:41', text: 'pool is a different concept' },
      { at: '2026-11-06T05:33', asked: 'Decision 6, the pool.', text: 'Keep both, as today' },
      { at: '2026-11-04T03:59', asked: 'Correction: a trial Koala on the pool can\'t use a machine at all today.', text: 'Adding it moves Koala there (Recommended)' },
    ],
    reading: 'The pool stays as it is (root\'s k3s or a separate pool server) and is outside v1. A trial user adding a machine moves Koala onto it.',
  },
  {
    id: 'dev-runs-like-prod',
    subject: 'The dev setup',
    terms: ['dev', 'npm run dev', 'watchers', 'Headscale'],
    words: [
      { at: '2026-11-05T17:42', text: 'I mean we need to run dev how it would run in prod' },
      { at: '2026-11-05T17:44', text: 'you need to define what the root node is and separate that from whatever your thinking a machine/instance is, dev should run whatever needs to run at the root, there shouldn\'t be anything special about running it here, that being said we need dev to be fast and be able to iterate quickly and see changes from the watchers' },
      { at: '2026-11-05T18:17', asked: 'Machines reach their Koala over the mesh, and this computer has no Tailscale.', text: 'Yes, join the dev mesh' },
      { at: '2026-11-05T18:17', asked: 'This computer\'s k3s (k3s-provisioning-lunorica) holds the current dev Koala\'s Gitea, Infisical, MinIO, apps and the GPU plugin. What becomes of it?', text: 'Replace it (Recommended)' },
      { at: '2026-11-05T23:17', text: 'I guess we can skip the migration but lets leave it still incase we need it' },
      { at: '2026-11-05T23:36', text: 'the console logs are super noisy, do they need to be?' },
      { at: '2026-11-05T21:30', text: 'lets show a tail of the ongoing install steps like 8 lines ish?' },
      { at: '2026-11-06T00:22', text: 'yes wire it into the local collector' },
      { at: '2026-11-06T00:24', text: 'ok wire it up' },
      { at: '2026-11-06T22:41', text: 'we can have dev\'s monitoring going through the local collector' },
    ],
    reading: 'Dev runs production\'s shape (root, this computer joined to the dev mesh as a machine, Koala on it) and stays fast with watchers. The old dev database is kept, not migrated. Dev\'s output is quiet, showing a short tail of what it is doing; dev\'s monitoring goes to the local collector.',
  },
  {
    id: 'pins',
    subject: 'Downloads during setup',
    terms: ['pin', 'cache', 'download'],
    words: [
      { at: '2026-11-05T14:52', asked: 'How should install.sh and machine.sh get k3s?', text: 'Pin + local cache (Recommended)' },
    ],
    reading: 'What setup downloads is pinned and cached.',
  },
  {
    id: 'tests-are-the-signal',
    subject: 'How Koala is tested',
    terms: ['test', 'integration', 'live suite', 'mock', 'contract'],
    words: [
      { at: '2026-11-05T18:46', text: 'we don\'t really want to make a hard and fast rule about how the application should be tested, it sounds like they need refactored, authenitcation should be tested by itself in isolation and we should only need a few e2e live tests like your talking about the existing scripts are doing, thats a super heavy way to test it' },
      { at: '2026-11-06T17:34', text: '13 - there should be different levels of testing, if we\'re testing the connection works and can write to mongo then yes a real mongo but we still need these tests to be quick, so if in memory is enough to test the business logic then thats fine, each test should be testing one concept.' },
      { at: '2026-11-06T17:34', text: '16 - test how fast it is vs a real instance, if its cheap enough to use the real thing then sure otherwise contract test, thats basically the concept for everything' },
      { at: '2026-11-06T05:40', asked: 'Decision 15, the deleted live suites.', text: 'Bring them back (Recommended)' },
      { at: '2026-11-06T05:40', asked: 'Decision 16, the coupling rules.', text: 'Back to strict (Recommended)' },
      { at: '2026-11-06T05:45', asked: 'Phase 0 makes every failure count toward your \'fails twice, then audit\' rule.', text: 'Gates always, live suites always (Recommended)' },
      { at: '2026-11-06T22:41', text: 'yes they can come back until we have confidence in the pyramid enough to cover what they do' },
      { at: '2026-11-06T14:46', asked: 'Four workspaces (the frontend, agent-engine, engine-core, context-engine) have no integration tests at all.', text: 'Write their integration tests now' },
    ],
    reading: 'Each test tests one concept, at the level it needs: in memory for business logic, the real dependency when the connection is what is tested. A stand-in is used only when the real thing is too slow, and then it has a contract suite. A few light live end-to-end suites in the end; the deleted ones come back and stay until the unit and integration tiers are trusted to cover what they do. Coupling rules strict; failures in gates and live suites always count.',
  },
  {
    id: 'references-not-questions',
    subject: 'What I settle myself',
    terms: ['references', 'types', 'grep'],
    words: [
      { at: '2026-11-06T17:34', text: '5 - Probably? you should be able to answer that kinda thing yourself by tracing how its being used? like an ide would show references, do you have tools to show references? if not thats a huge gap 6 - again, type issues you should be able to determine on how they are being used, they should be tighted to how they are getting written and read, we don\'t need loose types' },
      { at: '2026-11-06T17:37', text: 'grep is not a reasonable approach' },
      { at: '2026-11-06T18:02', text: 'I mean I\'m only really using you to code, I feel like you should have at least all the tools I would use in a ide' },
    ],
    reading: 'Type and reference questions are settled from real references, not asked and not grepped; types follow how values are written and read.',
  },
  {
    id: 'stay-aligned',
    subject: 'Asking before building',
    terms: ['drift', 'inconsistency', 'align'],
    words: [
      { at: '2026-11-06T00:13', text: 'you need to make sure my intention is understood before decided to reword what I said' },
      { at: '2026-11-06T21:43', text: 'Don\'t just ask one question after declaring a major difference in understand... that should trigger aligning on the plan...' },
      { at: '2026-11-06T22:04', text: 'i want to be asked when your unclear but I still feel like your not using the tools avalible to you if you are asking' },
      { at: '2026-11-06T22:11', text: 'I feel like its important we don\'t drift from each others understand, and that you ask me about inconsitances before we keep developing any more, so whatever we need to do to get to that point' },
      { at: '2026-11-04T00:29', text: 'I\'m confused about whats asking for what in a given context, I need more context' },
      { at: '2026-11-06T14:43', text: 'its just allot of info, so maybe make the things that are important stand out more' },
    ],
    reading: 'Never reword a decision. Find what the owner already said before asking; ask about every inconsistency before developing, with enough context to answer; a gap in understanding means re-aligning the plan, not one more question. Important things stand out.',
  },
  {
    id: 'sign-up-at-root',
    subject: 'Getting an account',
    terms: ['sign up', 'invite', 'register'],
    words: [
      { at: '2026-11-06T23:42', answering: 'A1: sign-up at root with an invite and an emailed code, built before the register; keep it as it is for v1?', text: 'A1 - sounds good' },
    ],
    reading: 'An account is made at root with an invite and a code emailed to the invited address, as built.',
  },
  {
    id: 'download-shown',
    subject: 'A model downloading onto a machine',
    terms: ['download', 'model cache'],
    words: [
      { at: '2026-11-06T23:42', answering: 'E5: while a model downloads onto the machine, the app\'s page shows the download?', text: 'E5 - Yep' },
    ],
    reading: 'A model downloads onto the machine it will run on, and the app\'s page shows the download while it happens.',
  },
  {
    id: 'automatic-updates',
    subject: 'Koala updating itself',
    terms: ['self-upgrade', 'automatic updates', 'rollback'],
    words: [
      { at: '2026-11-06T23:42', answering: 'H1: their Koala moves to root\'s newer release and rolls itself back, telling root why, when a new pod cannot recover; keep it?', text: 'H1 - Yep' },
    ],
    reading: 'On automatic updates a person\'s Koala moves to root\'s newer release and rolls itself back, telling root why, when a new pod cannot recover, as built.',
  },
  {
    id: 'roles',
    subject: 'What each Koala process is, and no combined role',
    terms: ['ROLE', 'combined', 'role'],
    words: [
      { at: '2026-11-07T00:30', text: 'Yeah didn\'t we already decide how dev would work? we just need to look at what each test is testing and fill out the ROLE' },
      { at: '2026-11-07T00:30', text: 'I wouldn\'t expect us needed to create clusters that often in a test suite?' },
    ],
    reading: 'ROLE says which process this is (root, an instance or the hub) and is required, with no default; the combined role goes. Each test runs as the role it tests. Tests reach no real cluster except the one testing the door to a cluster itself.',
  },
  {
    id: 'one-reverse-proxy',
    subject: 'Caddy is the one reverse proxy; the nginx router goes with combined',
    terms: ['nginx', 'caddy', 'Local router'],
    words: [
      { at: '2026-11-07T04:56', text: 'no, caddy is fine, remove it with combined' },
    ],
    reading: 'Apps are exposed only through Caddy: root\'s Caddy and each instance\'s edge. The host nginx container, its per-app files, the Local router page and Expose locally go with the combined role.',
  },
];
