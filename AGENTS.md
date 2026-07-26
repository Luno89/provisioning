# provisioning — agent instructions

Multi-cloud provisioning platform (k3d, k8s, CDKTF). Express backend + React 19 frontend.

See **[CLAUDE.md](./CLAUDE.md)** for all agent-facing guidance: architecture, commands, the service
layer, worker/Temporal design, GPU support, TypeScript quirks, and the testing escalation path.

This file previously carried its own full copy of that guidance. The two drifted apart (178
differing lines with no way to tell which was current), so `CLAUDE.md` is now the single source of
truth and this file points at it. It is kept so tools and editors that follow the `AGENTS.md`
convention still find their way.
