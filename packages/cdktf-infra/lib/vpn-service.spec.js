import { Testing, TerraformStack } from "cdktf";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
import { VpnService } from "./vpn-service.js";
function runTest() {
    console.log("🧪 Running VpnService unit tests...");
    // Mock CDKTF app and stack
    const app = Testing.app();
    const stack = new TerraformStack(app, "test-stack");
    const ns = new Namespace(stack, "test-ns", {
        metadata: { name: "test-ns" }
    });
    const podSpec = {
        container: [
            {
                name: "app-container",
                image: "nginx",
            }
        ]
    };
    // Test case 1: VPN disabled
    VpnService.apply(ns, "test-ns", podSpec, { vpnEnabled: false });
    if (podSpec.container.length !== 1) {
        throw new Error("FAIL: Disabled VPN should not add sidecar container");
    }
    console.log("✅ Disabled VPN test passed");
    // Test case 2: VPN enabled with wireguard config
    const config = {
        vpnEnabled: true,
        vpnProtocol: "wireguard",
        vpnConfig: "[Interface]\nPrivateKey = ...",
        vpnDedicatedIp: "1.2.3.4"
    };
    VpnService.apply(ns, "test-ns", podSpec, config);
    if (podSpec.container.length !== 2) {
        throw new Error("FAIL: Wireguard VPN should add a sidecar container");
    }
    const sidecar = podSpec.container[1];
    if (sidecar.name !== "vpn-sidecar") {
        throw new Error("FAIL: Sidecar container name is incorrect");
    }
    if (!sidecar.command.join(" ").includes("wireguard-tools")) {
        throw new Error("FAIL: Command should include wireguard-tools setup");
    }
    if (!podSpec.volume || podSpec.volume.length !== 1) {
        throw new Error("FAIL: Secret config volume was not added");
    }
    console.log("✅ WireGuard sidecar synthesis test passed");
    // Test case 3: VPN enabled with openvpn config
    const ns2 = new Namespace(stack, "test-ns2", {
        metadata: { name: "test-ns2" }
    });
    const podSpec2 = {
        container: [{ name: "app-container", image: "nginx" }]
    };
    const config2 = {
        vpnEnabled: true,
        vpnProtocol: "openvpn",
        vpnConfig: "client\ndev tun...",
        vpnDedicatedIp: "1.2.3.4"
    };
    VpnService.apply(ns2, "test-ns-2", podSpec2, config2);
    if (podSpec2.container.length !== 2) {
        throw new Error("FAIL: OpenVPN VPN should add a sidecar container");
    }
    const sidecar2 = podSpec2.container[1];
    if (!sidecar2.command.join(" ").includes("openvpn")) {
        throw new Error("FAIL: Command should include openvpn setup");
    }
    console.log("✅ OpenVPN sidecar synthesis test passed");
    console.log("🎉 All VpnService unit tests passed successfully!");
}
runTest();
