export const TAILSCALE_VERSION = '1.104.1';
export const TAILSCALE_SHA256_AMD64 = '108d1d96ecf410d305571e173516f27038f870919a9b89c914a167c6d33a4528';
export const TAILSCALE_SHA256_ARM64 = 'f60294374967f3dfd8cf57bbbd474d6cfce32d123e3a8ddeab82a87940daa806';
export const K3S_VERSION = 'v1.36.4+k3s1';
export const K3S_INSTALLER_SHA256 = '46177d4c99440b4c0311b67233823a8e8a2fc09693f6c89af1a7161e152fbfad';
export const K3S_SHA256_AMD64 = '835873f37245fc615f547a2fe2af9402a347875f13fa64a1f136de644955ea3f';
export const K3S_SHA256_ARM64 = 'c920706346d5ad4e5cd3c7bf1bb09ce71ebe07fec829e513e40f1caf98aed8bb';
export const NVIDIA_TOOLKIT_VERSION = '1.20.1-1';
export const NVIDIA_KEY_SHA256 = 'c880576d6cf75a48e5027a871bac70fd0421ab07d2b55f30877b21f1c87959c9';
export const HELM_VERSION = 'v3.15.1';
export const HELM_SHA256_AMD64 = '7b20e7791c04ea71e7fe0cbe11f1a8be4a55a692898b57d9db28f3b0c1d52f11';
export const HELM_SHA256_ARM64 = 'b4c5519b18f01dd2441f5e09497913dc1da1a1eec209033ae792a8d45b9e0e86';

export type Arch = 'amd64' | 'arm64';

export interface Pinned {
  version: string;
  sha256: Record<Arch, string>;
  url(arch: Arch): string;
}

export interface JoinPins {
  tailscale: Pinned;
  k3s: Pinned;
  k3sInstaller: { sha256: string; url: string };
  helm: Pinned;
  nvidia: { version: string; keySha256: string; repo: string };
}

const k3sTag = (version: string): string => version.replace('+', '%2B');

export const K3S_MIRROR = 'https://github.com/k3s-io/k3s/releases/download';

export function joinPins(k3sMirror: string = K3S_MIRROR): JoinPins {
  return {
    tailscale: {
      version: TAILSCALE_VERSION,
      sha256: { amd64: TAILSCALE_SHA256_AMD64, arm64: TAILSCALE_SHA256_ARM64 },
      url: (arch) => `https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_${arch}.tgz`,
    },
    k3s: {
      version: K3S_VERSION,
      sha256: { amd64: K3S_SHA256_AMD64, arm64: K3S_SHA256_ARM64 },
      url: (arch) => `${k3sMirror}/${k3sTag(K3S_VERSION)}/${arch === 'arm64' ? 'k3s-arm64' : 'k3s'}`,
    },
    k3sInstaller: { sha256: K3S_INSTALLER_SHA256, url: `https://raw.githubusercontent.com/k3s-io/k3s/${k3sTag(K3S_VERSION)}/install.sh` },
    helm: {
      version: HELM_VERSION,
      sha256: { amd64: HELM_SHA256_AMD64, arm64: HELM_SHA256_ARM64 },
      url: (arch) => `https://get.helm.sh/helm-${HELM_VERSION}-linux-${arch}.tar.gz`,
    },
    nvidia: { version: NVIDIA_TOOLKIT_VERSION, keySha256: NVIDIA_KEY_SHA256, repo: 'https://nvidia.github.io/libnvidia-container' },
  };
}
