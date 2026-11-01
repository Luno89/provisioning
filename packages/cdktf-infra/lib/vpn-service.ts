import { Construct } from "constructs";
import type { IResolvable } from "cdktf";
import { Secret } from "../.gen/providers/kubernetes/secret/index.js";
import type { DeploymentSpecTemplateSpecContainer, DeploymentSpecTemplateSpecVolume } from "../.gen/providers/kubernetes/deployment/index.js";

export interface VpnConfig {
  vpnEnabled?: boolean;
  vpnProtocol?: 'wireguard' | 'openvpn';
  vpnConfig?: string;
  vpnDedicatedIp?: string;
}

export interface SidecarPod {
  container?: DeploymentSpecTemplateSpecContainer[] | IResolvable;
  volume?: DeploymentSpecTemplateSpecVolume[] | IResolvable;
}

function listOf<T>(list: T[] | IResolvable | undefined, what: string): T[] {
  if (list === undefined) return [];
  if (Array.isArray(list)) return list;
  throw new Error(`the pod's ${what} is a Terraform token, so the VPN sidecar cannot be added to it`);
}

export class VpnService {
  static apply(
    scope: Construct,
    namespace: string,
    podSpec: SidecarPod,
    config: VpnConfig
  ) {
    if (!config || !config.vpnEnabled || !config.vpnConfig) {
      return;
    }

    const protocol = config.vpnProtocol || 'wireguard';
    const configFileName = protocol === 'wireguard' ? 'wg0.conf' : 'client.ovpn';

    const secret = new Secret(scope, "vpn-config-secret", {
      metadata: {
        name: "windscribe-vpn-config",
        namespace,
      },
      data: {
        [configFileName]: Buffer.from(config.vpnConfig).toString("base64"),
      },
    });

    const command = protocol === 'wireguard'
      ? [
        "sh",
        "-c",
        "apk add --no-cache wireguard-tools iproute2 && wg-quick up /config/wg0.conf && sleep infinity"
      ]
      : [
        "sh",
        "-c",
        "apk add --no-cache openvpn && mkdir -p /dev/net && [ -c /dev/net/tun ] || mknod /dev/net/tun c 10 200 && openvpn --config /config/client.ovpn"
      ];

    const sidecarContainer: DeploymentSpecTemplateSpecContainer = {
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
      command,
    };

    podSpec.container = [...listOf(podSpec.container, "containers"), sidecarContainer];
    podSpec.volume = [
      ...listOf(podSpec.volume, "volumes"),
      {
        name: "vpn-config-volume",
        secret: {
          secretName: secret.metadata.name,
        },
      },
    ];
  }
}
