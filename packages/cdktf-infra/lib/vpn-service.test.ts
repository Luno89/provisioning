import { Testing, TerraformStack } from "cdktf";
import { describe, expect, it } from "vitest";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
import type { DeploymentSpecTemplateSpecContainer, DeploymentSpecTemplateSpecVolume } from "../.gen/providers/kubernetes/deployment/index.js";
import { VpnService } from "./vpn-service.js";

interface PodSpec { container: DeploymentSpecTemplateSpecContainer[]; volume?: DeploymentSpecTemplateSpecVolume[] }

const namespaceIn = (id: string) => new Namespace(new TerraformStack(Testing.app(), `stack-${id}`), id, { metadata: { name: id } });
const appPod = (): PodSpec => ({ container: [{ name: "app-container", image: "nginx" }] });

describe("an app's VPN sidecar", () => {
  it("is not added when the app's VPN is off", () => {
    const pod = appPod();
    VpnService.apply(namespaceIn("off"), "off", pod, { vpnEnabled: false });
    expect(pod.container.map((container) => container.name)).toEqual(["app-container"]);
  });

  it("runs WireGuard from the config it is given, mounted from a secret", () => {
    const pod = appPod();
    VpnService.apply(namespaceIn("wg"), "wg", pod, { vpnEnabled: true, vpnProtocol: "wireguard", vpnConfig: "[Interface]\nPrivateKey = ...", vpnDedicatedIp: "1.2.3.4" });
    expect(pod.container.map((container) => container.name)).toEqual(["app-container", "vpn-sidecar"]);
    expect(pod.container[1]!.command!.join(" ")).toContain("wireguard-tools");
    expect(pod.volume).toHaveLength(1);
  });

  it("runs OpenVPN when that is the protocol", () => {
    const pod = appPod();
    VpnService.apply(namespaceIn("ovpn"), "ovpn", pod, { vpnEnabled: true, vpnProtocol: "openvpn", vpnConfig: "client\ndev tun...", vpnDedicatedIp: "1.2.3.4" });
    expect(pod.container[1]!.command!.join(" ")).toContain("openvpn");
  });
});
