import { randomBytes } from "node:crypto";
import { Construct } from "constructs";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
import { Deployment } from "../.gen/providers/kubernetes/deployment/index.js";
import { Service } from "../.gen/providers/kubernetes/service/index.js";
import { ConfigMap } from "../.gen/providers/kubernetes/config-map/index.js";
import { Secret } from "../.gen/providers/kubernetes/secret/index.js";
import { VpnService } from "../lib/vpn-service.js";
import { createAppIngress } from "../lib/app-ingress.js";
import { createAppProbe } from "../lib/app-probe.js";
export class SearxngNativeApp extends Construct {
    constructor(scope, id, config = {}) {
        super(scope, id);
        const namespaceName = config.namespace || "searxng";
        const image = `${config.webRepo || "searxng/searxng"}:${config.webTag || "latest"}`;
        const serviceType = config.serviceType || (process.env.SELF_MANAGED_K8S === "true" ? "NodePort" : "LoadBalancer");
        const ns = new Namespace(this, "ns", {
            metadata: { name: namespaceName },
        });
        // Terraform state is not a secret store, but it is where an inline value would end up. A
        // generated key lives in a Secret so it is at least scoped to the namespace and not printed in
        // a plan diff alongside the rest of the settings.
        const secretKey = config.secretKey || randomBytes(32).toString("hex");
        const secret = new Secret(this, "secret", {
            metadata: { name: "searxng-secret", namespace: ns.metadata.name },
            // Plaintext, not base64 — the provider encodes `data` itself and `binaryData` is the
            // pre-encoded one. Several older constructs here base64 it by hand and so store a
            // double-encoded value; harmless where both ends read the same secret, wrong in general.
            data: { secret_key: secretKey },
            type: "Opaque",
        });
        /**
         * `use_default_settings: true` merges over the image's own settings rather than replacing them.
         *
         * Replacing would mean vendoring SearXNG's ~3,400-line engine list into this repo and having it
         * rot against every upgrade. Merging means this file only states the things the agent needs
         * that differ from stock.
         */
        const settingsYaml = [
            "use_default_settings: true",
            "server:",
            // Read from the Secret at boot by the image's own ${SEARXNG_SECRET} substitution.
            '  secret_key: "@SEARXNG_SECRET@"',
            // The limiter exists to stop a PUBLIC instance being scraped. This one is reachable only
            // from inside the cluster, and its intended client is a program — leaving it on would rate
            // limit the agent for looking exactly like what it is.
            "  limiter: false",
            "  image_proxy: false",
            "search:",
            "  formats:",
            // html stays so a human can open it and see what the agent sees. json is the entire point.
            "    - html",
            "    - json",
            // The agent searches for technical documentation, which is not language-scoped and is often
            // not in the instance's locale.
            "  default_lang: all",
            ...(config.engines
                ? ["engines:", ...config.engines.split(",").map((e) => e.trim()).filter(Boolean).flatMap((e) => [
                        `  - name: ${e}`,
                        "    disabled: false",
                    ])]
                : []),
            "",
        ].join("\n");
        const settings = new ConfigMap(this, "settings", {
            metadata: { name: "searxng-settings", namespace: ns.metadata.name },
            data: { "settings.yml": settingsYaml },
        });
        const podSpec = {
            container: [
                {
                    name: "searxng",
                    image,
                    // A ConfigMap mount is read-only, and the image's entrypoint wants to own its config
                    // directory. Copying to a writable path first sidesteps that, and is also where the
                    // secret gets substituted in — a ConfigMap cannot reference a Secret, and putting the
                    // key in the ConfigMap would defeat having a Secret at all.
                    command: ["/bin/sh", "-c"],
                    args: [[
                            "cp /config-src/settings.yml /etc/searxng/settings.yml",
                            '&& sed -i "s|@SEARXNG_SECRET@|$SEARXNG_SECRET|" /etc/searxng/settings.yml',
                            "&& exec /usr/local/searxng/entrypoint.sh",
                        ].join(" ")],
                    env: [
                        { name: "SEARXNG_BIND_ADDRESS", value: "0.0.0.0" },
                        { name: "SEARXNG_PORT", value: "8080" },
                        {
                            name: "SEARXNG_SECRET",
                            valueFrom: { secretKeyRef: { name: secret.metadata.name, key: "secret_key" } },
                        },
                    ],
                    port: [{ containerPort: 8080 }],
                    volumeMount: [{ name: "settings", mountPath: "/config-src", readOnly: true }],
                    resources: {
                        // Small and predictable: it holds no index, it fans a query out to other people's
                        // engines and merges the replies. The limit is here because this shares a node with a
                        // 20GB model, where an unbounded pod is the one that gets everything else killed.
                        limits: { memory: "1Gi", cpu: "1000m" },
                        requests: { memory: "256Mi", cpu: "100m" },
                    },
                },
            ],
            volume: [{ name: "settings", configMap: { name: settings.metadata.name } }],
        };
        VpnService.apply(this, ns.metadata.name, podSpec, config);
        new Deployment(this, "searxng-deployment", {
            metadata: {
                name: "searxng",
                namespace: ns.metadata.name,
                labels: { app: `searxng-${id}` },
            },
            spec: {
                replicas: "1",
                selector: { matchLabels: { app: `searxng-${id}` } },
                template: {
                    metadata: { labels: { app: `searxng-${id}` } },
                    spec: podSpec,
                },
            },
        });
        new Service(this, "searxng-service", {
            metadata: { name: "searxng", namespace: ns.metadata.name },
            spec: {
                type: serviceType,
                selector: { app: `searxng-${id}` },
                port: [{ port: 8080, targetPort: "8080" }],
            },
        });
        createAppIngress(this, "ingress", {
            namespace: namespaceName,
            serviceName: "searxng",
            servicePort: 8080,
            hostname: `${namespaceName}.apps.local`,
        });
        createAppProbe(this, "probe", {
            namespace: namespaceName,
            serviceName: "searxng",
            servicePort: 8080,
        });
    }
}
