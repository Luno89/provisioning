import { TerraformOutput, TerraformStack, Token } from "cdktf";
import { HcloudProvider } from "../.gen/providers/hcloud/provider/index.js";
import { Server } from "../.gen/providers/hcloud/server/index.js";
import { SshKey } from "../.gen/providers/hcloud/ssh-key/index.js";
import { Firewall } from "../.gen/providers/hcloud/firewall/index.js";
// k3s + this platform's cluster stack (kube-prometheus-stack, Traefik, Loki) measures at a ~5GB
// working set before any app is deployed — see tests/lib/memory-budget.ts. Defaulting to CX53
// (16 vCPU / 32GB) leaves real headroom for apps; an undersized node fails at *deploy* time
// rather than at create time, which is a much worse place to find out.
//
// Must stay an x86 plan: CAX plans are ARM64 and several deployable images are x86-64 only.
export const HETZNER_DEFAULT_SERVER_TYPE = "cx53";
export const HETZNER_DEFAULT_LOCATION = "nbg1";
export const HETZNER_DEFAULT_IMAGE = "ubuntu-24.04";
/**
 * Creates the VM that a `provider: 'hetzner'` cluster lives on — the "create the machine" half of
 * the distributed-systems plan's Phase 3. Everything *after* the VM exists is deliberately not
 * here: ProvisionClusterActivity hands the resulting IP straight to Phase 2's generic SSH k3s
 * bootstrap (ProvisionRemoteHostActivity), so a Hetzner VM and a user's own GPU workstation are
 * the same thing from that point on.
 *
 * Kept as its own TerraformStack rather than folded into ClusterStack because it has a different
 * *provider* (hcloud, not kubernetes/helm) and must be applied strictly before the cluster stack
 * can even connect — the kubeconfig ClusterStack needs doesn't exist until k3s is installed on
 * the machine this stack creates.
 */
export class HetznerVmStack extends TerraformStack {
    constructor(scope, id, config) {
        super(scope, id);
        // No explicit `token` — the provider reads HCLOUD_TOKEN from the environment, which is what
        // credential-resolver.ts's 'hetzner' case produces. Keeps the secret out of synthesized
        // Terraform JSON on disk.
        new HcloudProvider(this, "hcloud", {});
        const sshKey = new SshKey(this, "ssh-key", {
            name: `${config.name}-key`,
            publicKey: config.sshPublicKey,
            labels: { managed_by: "provisioning-platform", cluster: config.name },
        });
        // Hetzner firewalls are default-deny inbound: anything not matched by a rule below is
        // dropped. That is the entire security posture the plan calls for — note there is
        // deliberately NO rule for 6443. The k3s API server is reachable only over the Headscale
        // mesh, whose traffic arrives inside the WireGuard tunnel and so is never evaluated against
        // these rules, rather than being exposed to the raw internet.
        const firewall = new Firewall(this, "firewall", {
            name: `${config.name}-fw`,
            labels: { managed_by: "provisioning-platform", cluster: config.name },
            rule: [
                {
                    description: "SSH — needed to bootstrap k3s and to join the mesh in the first place",
                    direction: "in",
                    protocol: "tcp",
                    port: "22",
                    sourceIps: ["0.0.0.0/0", "::/0"],
                },
                {
                    // Tailscale/Headscale clients prefer a direct WireGuard path and fall back to a
                    // relay (DERP) if this is blocked — working either way, but far slower relayed.
                    description: "WireGuard — direct mesh connectivity for the Headscale-joined node",
                    direction: "in",
                    protocol: "udp",
                    port: "41641",
                    sourceIps: ["0.0.0.0/0", "::/0"],
                },
                {
                    description: "ICMP — ping/MTU discovery, needed for usable diagnostics",
                    direction: "in",
                    protocol: "icmp",
                    sourceIps: ["0.0.0.0/0", "::/0"],
                },
                // Game-server ports, opened unconditionally rather than per-deployment. This firewall is
                // created during CLUSTER provisioning (host worker), long before any app deploy reaches
                // the cluster worker, so there is no clean point at which to add a rule "when a game
                // server is deployed" — and patching it from the app path would be reverted by the next
                // `cdktf deploy` of the VM stack as state drift.
                //
                // Safe to leave open: behind Hetzner's default-deny, a UDP port with nothing bound to it
                // simply drops traffic. Same posture as the deliberate absence of a 6443 rule above.
                // Ports match constructs/palworld.ts (see lib/game-server-ports.ts).
                {
                    description: "Palworld game traffic",
                    direction: "in",
                    protocol: "udp",
                    port: "8211",
                    sourceIps: ["0.0.0.0/0", "::/0"],
                },
                {
                    description: "Palworld Steam query — server-browser listings",
                    direction: "in",
                    protocol: "udp",
                    port: "27015",
                    sourceIps: ["0.0.0.0/0", "::/0"],
                },
            ],
        });
        const server = new Server(this, "server", {
            name: config.name,
            serverType: config.serverType || HETZNER_DEFAULT_SERVER_TYPE,
            image: config.image || HETZNER_DEFAULT_IMAGE,
            location: config.location || HETZNER_DEFAULT_LOCATION,
            sshKeys: [sshKey.name],
            // `id` is exposed as a string but firewallIds is number[] — Token.asNumber carries the
            // unresolved reference through synthesis instead of forcing it to a value at build time.
            firewallIds: [Token.asNumber(firewall.id)],
            labels: { managed_by: "provisioning-platform", cluster: config.name },
        });
        // Read back by ProvisionHetznerVmActivity via `cdktf deploy --outputs-file`. Snake_case
        // because that's the key the outputs file is written under.
        new TerraformOutput(this, "ipv4_address", { value: server.ipv4Address });
        new TerraformOutput(this, "server_id", { value: server.id });
    }
}
