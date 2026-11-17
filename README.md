# Koala

Your own Koala on your own machines. Join a computer to your account, and Koala runs on it: deploy a model server on its GPUs (vLLM
or TabbyAPI) and chat with your own model, deploy apps (Odoo, WordPress, Nextcloud, Audiobookshelf, Open WebUI and more), and hand
software work to agents that plan it, build it in a sandbox and have it judged before it counts.

Machines join over a WireGuard mesh (Headscale), dialling outward, so a computer behind your home NAT needs no port forwarding and no
dynamic DNS.

## How it fits together

- **Root** holds accounts and signs everyone in, runs the mesh, routes each person's addresses through its Caddy and sends mail.
- **A machine** is one of your computers, added to your account at root with one command. It is exactly one Kubernetes cluster:
  native k3s, which can use its GPUs, or k3d in Docker without them. It starts when something runs on it and stops when idle. Its
  agent also runs coding agents you have there (Claude Code, Codex, Gemini, Antigravity, Goose).
- **Your Koala** (an instance) is a set of pods on one of your machines, signed in through root.
- **The hub** holds projects you share with other people.
- **The pool** lets someone without a machine try Koala on Koala's servers, and move to their own machine later.

| Part | What |
|---|---|
| `apps/backend` | The API, its Temporal workers and the agent engine's host; one program that runs as root, an instance or the hub |
| `apps/frontend` | React; the same app serves root, an instance and the hub |
| `apps/local-agent` | The machine agent: joins a machine, runs its k3s and coding agents, updates itself |
| `packages/agent-engine`, `engine-core`, `context-engine`, `harness-types` | Procedures, tools, model calls and the shapes they share |
| `packages/cdktf-infra` | Terraform stacks for each app |
| `charts/instance` | The Helm chart that is a person's Koala |
| `scripts/root-node` | Standing up and updating a hosted root (see `docs/runbook.md`) |

## Running it on your computer

Linux with Docker, Node.js 20+ and, for models, an NVIDIA or AMD GPU with its driver.

```bash
sudo bash scripts/setup-root.sh   # once: Docker, the docker group, firewalld
npm run setup                     # as yourself: binaries, packages, Terraform bindings, the platform keys
npm run dev                       # root and the hub; the first time, this computer joins as a machine and Koala installs on it
```

The first `npm run dev` asks for your password once, for the join: k3s and, with an NVIDIA GPU, NVIDIA's container toolkit. Then
sign in at http://koala.localhost:5175; your Koala is at http://dev.localhost:5173 and the hub at http://hub.localhost:5176.

The dev stack is disposable: `npm run dev:reset` removes this computer as a machine and everything dev made, and the next
`npm run dev` starts it fresh. Everything hot-reloads, and a reload stops whatever that process was running.

## Tests and shipping

```bash
npm run test:unit          # typecheck and every unit test, nothing outside the process
npm run test:integration   # the real dependencies on this computer: Mongo, Temporal, k3s in Docker
npm run test:v1-live       # v1 end to end in a browser, on this computer's GPUs
npm run ship               # a fresh dev stack, every gate, then push main
npm run release            # the release gates on a shipped commit, then a signed tag
```

How the work is done here (the rules, the decisions and the structure) is in `CLAUDE.md`.
