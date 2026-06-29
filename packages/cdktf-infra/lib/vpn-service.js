import { Secret } from "../.gen/providers/kubernetes/secret/index.js";
export class VpnService {
    static apply(scope, namespace, podSpec, // This is the pod template spec (spec.template.spec)
    config) {
        if (!config || !config.vpnEnabled || !config.vpnConfig) {
            return;
        }
        const protocol = config.vpnProtocol || 'wireguard';
        const configFileName = protocol === 'wireguard' ? 'wg0.conf' : 'client.ovpn';
        // 1. Create a Kubernetes Secret containing the VPN config
        const secret = new Secret(scope, "vpn-config-secret", {
            metadata: {
                name: "windscribe-vpn-config",
                namespace,
            },
            data: {
                [configFileName]: Buffer.from(config.vpnConfig).toString("base64"),
            },
        });
        // 2. Define the VPN sidecar container
        const sidecarContainer = {
            name: "vpn-sidecar",
            image: "alpine:3.19",
            securityContext: {
                capabilities: {
                    add: ["NET_ADMIN"],
                },
            },
            volumeMount: [
                {
                    name: "vpn-config-volume",
                    mountPath: "/config",
                    readOnly: true,
                },
            ],
        };
        if (protocol === 'wireguard') {
            sidecarContainer.command = [
                "sh",
                "-c",
                "apk add --no-cache wireguard-tools iproute2 && wg-quick up /config/wg0.conf && sleep infinity"
            ];
        }
        else {
            sidecarContainer.command = [
                "sh",
                "-c",
                "apk add --no-cache openvpn && mkdir -p /dev/net && [ -c /dev/net/tun ] || mknod /dev/net/tun c 10 200 && openvpn --config /config/client.ovpn"
            ];
        }
        // 3. Append the sidecar container to podSpec
        if (!podSpec.container) {
            podSpec.container = [];
        }
        podSpec.container.push(sidecarContainer);
        // 4. Append the secret volume to podSpec
        if (!podSpec.volume) {
            podSpec.volume = [];
        }
        podSpec.volume.push({
            name: "vpn-config-volume",
            secret: {
                secretName: secret.metadata.name,
            },
        });
    }
}
